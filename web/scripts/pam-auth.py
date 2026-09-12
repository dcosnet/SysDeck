#!/usr/bin/env python3
"""SysDeck web edition — PAM authentication helper (v0.4.0).

This is the same mechanism Cockpit uses for its login: hand the
username + password to the host's PAM stack (pam_unix and friends) and
let the system decide. No password database of our own, no hashing
scheme of our own — the *host's* account system is the source of truth.

Protocol
    stdin : one JSON document  {"user": "...", "password": "...", "service": "sysdeck"}
    stdout: one JSON document  {"ok": bool, "user": str?, "reason": str?, "code": int?}
    exit  : 0 when authentication succeeded, 1 otherwise (JSON still printed)

Design notes (they matter):
  * The password arrives on STDIN, never argv — argv is world-readable
    in /proc/<pid>/cmdline. The document is read once with a size cap
    and scrubbed after use where practical.
  * The PAM conversation callback answers only PAM_PROMPT_ECHO_OFF
    (password) and PAM_PROMPT_ECHO_ON (user) messages; anything else
    (info/error) is acknowledged with an empty reply so exotic stacks
    cannot fish for extra data.
  * pam_acct_mgmt() runs after authenticate — the account must also be
    allowed to log in right now (expiry / lock / time-of-day rules that
    the stack enforces).
  * Service name: SYSDECK_PAM_SERVICE / the request's "service" field
    (default "sysdeck") first, so operators can ship a tailored
    /etc/pam.d/sysdeck stack; when that stack does not exist the helper
    falls back to "login" — the stack the console TTY uses, which is
    what "log in like at the console" means on a stock distro.
  * stdlib only (ctypes + json + sys). If libpam is missing, report
    {"ok": false, "reason": "pam-unavailable"} so the caller can route
    to the local-account fallback.

Root notes: pam_unix needs root to read /etc/shadow for ARBITRARY
users. A non-root process goes through unix_chkpwd, which only verifies
the INVOKING user's password (a pam_unix guarantee, not ours). So: run
the web console as root (systemd unit) to accept logins from any Unix
account — exactly how cockpit-ws is deployed — or use
SYSDECK_AUTH_MODE=pam+local / local for unprivileged installs.
"""
import ctypes
import json
import sys

MAX_DOC_BYTES = 64 * 1024  # a JSON doc with a password is never this big

PAM_SUCCESS = 0
PAM_PROMPT_ECHO_OFF = 1  # password
PAM_PROMPT_ECHO_ON = 2  # username
PAM_ERROR_MSG = 3
PAM_TEXT_INFO = 4
PAM_CONV_ERR = 19

EXIT_OK = 0
EXIT_FAIL = 1


def load_libc():
    for name in ("libc.so.6", "libc.so"):
        try:
            libc = ctypes.CDLL(name)
            libc.strdup.restype = ctypes.c_void_p
            libc.strdup.argtypes = [ctypes.c_char_p]
            libc.malloc.restype = ctypes.c_void_p
            libc.malloc.argtypes = [ctypes.c_size_t]
            return libc
        except OSError:
            continue
    return None


def load_libpam():
    for name in ("libpam.so.0", "libpam.so"):
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


class PamMessage(ctypes.Structure):
    _fields_ = [("msg_style", ctypes.c_int), ("msg", ctypes.c_char_p)]


class PamResponse(ctypes.Structure):
    _fields_ = [("resp", ctypes.c_char_p), ("resp_retcode", ctypes.c_int)]


PAM_CONV_FUNC = ctypes.CFUNCTYPE(
    ctypes.c_int,  # return
    ctypes.c_int,  # num_msg
    ctypes.POINTER(ctypes.POINTER(PamMessage)),
    ctypes.POINTER(ctypes.POINTER(PamResponse)),
    ctypes.c_void_p,  # appdata_ptr
)


class PamConv(ctypes.Structure):
    _fields_ = [("conv", PAM_CONV_FUNC), ("appdata_ptr", ctypes.c_void_p)]


def out(doc, code):
    sys.stdout.write(json.dumps(doc))
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(code)


def main():
    # 1. credentials arrive on stdin (never argv)
    try:
        raw = sys.stdin.buffer.read(MAX_DOC_BYTES + 1)
    except Exception:
        out({"ok": False, "reason": "stdin-read-error"}, EXIT_FAIL)
    if not raw or len(raw) > MAX_DOC_BYTES:
        out({"ok": False, "reason": "bad-request"}, EXIT_FAIL)
    try:
        doc = json.loads(raw.decode("utf-8"))
    except Exception:
        out({"ok": False, "reason": "bad-json"}, EXIT_FAIL)

    user = doc.get("user")
    password = doc.get("password")
    service = doc.get("service") or "sysdeck"
    if not isinstance(user, str) or not isinstance(password, str) or not user:
        out({"ok": False, "reason": "bad-request"}, EXIT_FAIL)
    if len(user) > 64 or len(password) > 512:
        out({"ok": False, "reason": "oversized-credential"}, EXIT_FAIL)

    # 2. libpam + libc must be present (libc owns the reply allocation —
    #    Linux-PAM free()s the conversation replies itself, so they must
    #    come from the C allocator, never from Python-managed buffers)
    libpam = load_libpam()
    libc = load_libc()
    if libpam is None or libc is None:
        out({"ok": False, "reason": "pam-unavailable"}, EXIT_FAIL)

    libpam.pam_start.restype = ctypes.c_int
    libpam.pam_start.argtypes = [
        ctypes.c_char_p,  # const char *service_name
        ctypes.c_char_p,  # const char *user
        ctypes.POINTER(PamConv),  # const struct pam_conv *
        ctypes.POINTER(ctypes.c_void_p),  # pam_handle_t **
    ]
    libpam.pam_authenticate.restype = ctypes.c_int
    libpam.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libpam.pam_acct_mgmt.restype = ctypes.c_int
    libpam.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
    libpam.pam_end.restype = ctypes.c_int
    libpam.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]

    c_user = user.encode("utf-8")
    c_pass = password.encode("utf-8")

    # The conversation callback answers from the C allocator: Linux-PAM
    # free()s both the reply array and the reply strings after the
    # exchange, so Python-managed buffers would corrupt the heap. The
    # callback closure captures c_user / c_pass directly — no
    # appdata_ptr plumbing needed.

    @PAM_CONV_FUNC
    def conv(num_msg, msg, resp, appdata_ptr):
        try:
            RESP_SZ = ctypes.sizeof(PamResponse)
            arr = libc.malloc(num_msg * RESP_SZ)
            if not arr:
                return PAM_CONV_ERR
            for i in range(num_msg):
                style = msg[i].contents.msg_style
                text = None
                if style == PAM_PROMPT_ECHO_OFF:
                    text = c_pass
                elif style == PAM_PROMPT_ECHO_ON:
                    text = c_user
                # PAM_ERROR_MSG / PAM_TEXT_INFO → acknowledged empty
                s = libc.strdup(text) if text is not None else None
                entry = PamResponse(resp=ctypes.cast(s, ctypes.c_char_p), resp_retcode=0)
                ctypes.memmove(
                    ctypes.c_void_p(arr + i * RESP_SZ),
                    ctypes.byref(entry),
                    RESP_SZ,
                )
            resp[0] = ctypes.cast(arr, ctypes.POINTER(PamResponse))
            return PAM_SUCCESS
        except Exception:
            return PAM_CONV_ERR

    conv_struct = PamConv(conv=conv, appdata_ptr=None)

    def attempt(svc_name):
        handle = ctypes.c_void_p()
        rc = libpam.pam_start(
            svc_name.encode("utf-8"), c_user, ctypes.byref(conv_struct), ctypes.byref(handle)
        )
        if rc != PAM_SUCCESS:
            return None, rc
        try:
            rc = libpam.pam_authenticate(handle, 0)
            if rc == PAM_SUCCESS:
                rc = libpam.pam_acct_mgmt(handle, 0)
            return rc == PAM_SUCCESS, rc
        finally:
            libpam.pam_end(handle, rc)

    # 3. authenticate — pick the PAM stack explicitly. An unconfigured
    #    service name silently routes through /etc/pam.d/other (often a
    #    deny-or-worse default), so the stack is only used when its file
    #    exists; otherwise "login" — the stack the console TTY uses — is
    #    the honest stand-in for "log in like at the console".
    import os

    pam_d_candidates = ("/etc/pam.d", "/usr/etc/pam.d", "/lib/live/service/pam.d")
    have_stack = any(
        os.path.isfile(os.path.join(d, service)) for d in pam_d_candidates
    )
    chosen = service if have_stack else "login"
    ok, rc = attempt(chosen)
    if ok is None:
        out({"ok": False, "reason": "pam-start-error", "code": int(rc)}, EXIT_FAIL)
    if ok:
        out({"ok": True, "user": user}, EXIT_OK)
    out({"ok": False, "reason": "auth-failed", "code": int(rc)}, EXIT_FAIL)


if __name__ == "__main__":
    main()
