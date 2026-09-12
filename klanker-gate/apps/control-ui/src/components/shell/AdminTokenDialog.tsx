import { useState } from "react";
import { Dialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { Field } from "../ui/label";
import { Input } from "../ui/input";
import { useToast } from "../ui/toast";
import { clearAdminToken, hasAdminToken, saveAdminToken } from "../../api";

export interface AdminTokenDialogProps {
  open: boolean;
  onClose: () => void;
  /** Bump the active view so its fetches re-fire after a token change. */
  onTokenChange: () => void;
}

export function AdminTokenDialog(
  { open, onClose, onTokenChange }: AdminTokenDialogProps,
) {
  const [token, setToken] = useState("");
  const toast = useToast();

  function reset() {
    setToken("");
    onClose();
  }

  function save() {
    const value = token.trim();
    if (!value) {
      return;
    }
    saveAdminToken(value);
    toast.success("Admin token saved");
    onTokenChange();
    reset();
  }

  function clear() {
    clearAdminToken();
    toast.info("Admin token cleared");
    onTokenChange();
    reset();
  }

  return (
    <Dialog
      open={open}
      onClose={reset}
      title="Admin token"
      description="Sent as Authorization: Bearer on every /api and /metrics request. Stored in sessionStorage, cleared when this tab closes."
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={clear} disabled={!hasAdminToken()}>
            Clear token
          </Button>
          <Button onClick={save} disabled={!token.trim()}>
            Save token
          </Button>
        </>
      }
    >
      <Field id="admin-token" label="Admin token">
        <Input
          id="admin-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
        />
      </Field>
    </Dialog>
  );
}
