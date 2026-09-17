#!/usr/bin/env python3
"""SysDeck - Hardware Alert Bridge
Detects foreign/unauthorized devices, USB mass storage, DMA-capable
Thunderbolt/FireWire, rogue Bluetooth, new PCI devices, RFID/NFC
skimmers, firmware tampering, and other hardware intrusion indicators.

Subcommands:
  summary             - full alert summary with all devices and policy
  devices             - list all detected hardware devices
  alerts              - list active alerts only
  acknowledge <id>    - acknowledge an alert
  dismiss <id>        - dismiss an alert
  block <device-id>   - block a device (USB authorize=0 or udev rule)
  unblock <device-id> - unblock a device
  whitelist <device-id> - add device to whitelist
  unwhitelist <device-id> - remove device from whitelist
  policy <key> <val>  - update a policy toggle

Author: Jeremy Anderson (https://dcos.net)
"""

import json
import subprocess
import sys
import os
import re
import glob as globmod
from datetime import datetime, timezone

# ── Helpers ──────────────────────────────────────────────────

def run(cmd, timeout=10):
    """Run a command, return stdout or empty string."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def read_file(path):
    try:
        with open(path, 'r') as f:
            return f.read().strip()
    except Exception:
        return ""


# ── Policy (persisted to /etc/sysdeck/hw-policy.json) ───────

POLICY_PATH = "/etc/sysdeck/hw-policy.json"
WHITELIST_PATH = "/etc/sysdeck/hw-whitelist.json"

DEFAULT_POLICY = {
    "blockUsbStorage": True,
    "blockThunderboltDMA": True,
    "blockFirewireDMA": True,
    "blockUnknownBluetooth": True,
    "blockUnknownPCI": False,
    "autoBlock": True,
    "alertOnly": False,
    "whitelistEnforced": True,
}


def load_policy():
    try:
        with open(POLICY_PATH, 'r') as f:
            return json.load(f)
    except Exception:
        return dict(DEFAULT_POLICY)


def save_policy(policy):
    try:
        os.makedirs(os.path.dirname(POLICY_PATH), exist_ok=True)
        with open(POLICY_PATH, 'w') as f:
            json.dump(policy, f, indent=2)
    except Exception:
        pass  # Best effort — may lack write perms


def load_whitelist():
    try:
        with open(WHITELIST_PATH, 'r') as f:
            return json.load(f)
    except Exception:
        return []


def save_whitelist(wl):
    try:
        os.makedirs(os.path.dirname(WHITELIST_PATH), exist_ok=True)
        with open(WHITELIST_PATH, 'w') as f:
            json.dump(wl, f, indent=2)
    except Exception:
        pass


def is_whitelisted(device, whitelist):
    """Check if device matches any whitelist entry by vendorId:productId or serial."""
    for entry in whitelist:
        if entry.get("serial") and device.get("serial") and entry["serial"] == device["serial"]:
            return True
        if (entry.get("vendorId") == device.get("vendorId") and
            entry.get("productId") == device.get("productId") and
            not entry.get("serial")):
            return True
    return False


# ── Device Scanners ─────────────────────────────────────────

def scan_usb_devices():
    """Scan /sys/bus/usb/devices/ for USB devices."""
    devices = []
    usb_base = "/sys/bus/usb/devices"
    if not os.path.isdir(usb_base):
        return devices

    for entry in os.listdir(usb_base):
        path = os.path.join(usb_base, entry)
        if not os.path.isdir(path):
            continue

        # Skip USB hubs (root hubs show as usbX)
        if re.match(r'^usb\d+', entry) and '-' not in entry:
            continue

        vendor_id = read_file(os.path.join(path, "idVendor"))
        product_id = read_file(os.path.join(path, "idProduct"))
        if not vendor_id or not product_id:
            continue

        vendor = read_file(os.path.join(path, "manufacturer")) or f"Vendor {vendor_id}"
        product = read_file(os.path.join(path, "product")) or f"USB Device {product_id}"
        serial = read_file(os.path.join(path, "serial"))
        driver = ""

        # Check for driver
        driver_link = os.path.join(path, "driver")
        if os.path.islink(driver_link):
            driver = os.path.basename(os.readlink(driver_link))

        # Check authorization
        authorized = read_file(os.path.join(path, "authorized"))
        is_authorized = authorized == "1"

        # Detect interface classes
        interfaces = []
        for iface_dir in sorted(globmod.glob(os.path.join(path, "*", "bInterfaceClass"))):
            iface_class = read_file(iface_dir)
            class_map = {
                "08": "mass-storage", "03": "hid", "0e": "video",
                "01": "audio", "06": "image", "07": "printer",
                "0a": "cdc", "02": "cdc", "0b": "chipcard",
                "e0": "wireless", "ff": "vendor-specific",
            }
            interfaces.append(class_map.get(iface_class, f"class-{iface_class}"))

        # Check for mass storage — find /dev/ path and size
        dev_path = ""
        size_bytes = 0
        mount_point = ""
        has_mass_storage = "mass-storage" in interfaces

        if has_mass_storage:
            # Try to find block device
            for host_dir in globmod.glob(os.path.join(path, "host*/target*/*/block/*")):
                dev_name = os.path.basename(host_dir)
                dev_path = f"/dev/{dev_name}"
                size_str = read_file(os.path.join(host_dir, "size"))
                if size_str and size_str.isdigit():
                    size_bytes = int(size_str) * 512  # sectors * 512 bytes
                break
            # Also check via scsi disk link
            if not dev_path:
                for scsi_disk in globmod.glob(os.path.join(path, "host*/target*/*/scsi_disk")):
                    parent = os.path.dirname(scsi_disk)
                    for blk in globmod.glob(os.path.join(parent, "block/*")):
                        dev_name = os.path.basename(blk)
                        dev_path = f"/dev/{dev_name}"
                        break

            # Check mount
            if dev_path:
                mount_out = run(["findmnt", "-n", "-o", "TARGET", dev_path], timeout=3)
                if mount_out:
                    mount_point = mount_out

        # Determine bus type
        bus_type = "usb"

        # DMA: USB devices themselves are not DMA-capable in the traditional sense,
        # but USB4/TB tunnels can be. Check for Thunderbolt tunnel.
        dma_capable = False

        device = {
            "id": path,
            "name": product,
            "vendor": vendor,
            "vendorId": vendor_id,
            "productId": product_id,
            "serial": serial,
            "busType": bus_type,
            "driver": driver,
            "devPath": dev_path,
            "sysPath": path,
            "authorized": is_authorized,
            "interfaces": interfaces,
            "mountPoint": mount_point,
            "sizeBytes": size_bytes,
            "dmaCapable": dma_capable,
            "firstSeen": now_iso(),  # Best effort — real impl would use udev history
            "whitelisted": False,    # Set later
        }
        devices.append(device)

    return devices


def scan_thunderbolt_devices():
    """Scan /sys/bus/thunderbolt/devices/ for Thunderbolt devices."""
    devices = []
    tb_base = "/sys/bus/thunderbolt/devices"
    if not os.path.isdir(tb_base):
        return devices

    for entry in os.listdir(tb_base):
        path = os.path.join(tb_base, entry)
        if not os.path.isdir(path):
            continue
        # Skip the domain controller (domain0)
        if entry.startswith("domain"):
            continue

        vendor = read_file(os.path.join(path, "vendor_name")) or "Unknown TB Device"
        product = read_file(os.path.join(path, "device_name")) or entry
        vendor_id = read_file(os.path.join(path, "vendor_id")) or ""
        device_id = read_file(os.path.join(path, "device_id")) or ""
        serial = read_file(os.path.join(path, "unique_id")) or ""
        authorized = read_file(os.path.join(path, "authorized"))
        is_authorized = authorized == "1"

        # All Thunderbolt devices are DMA-capable
        device = {
            "id": path,
            "name": product,
            "vendor": vendor,
            "vendorId": vendor_id,
            "productId": device_id,
            "serial": serial,
            "busType": "thunderbolt",
            "driver": "thunderbolt",
            "devPath": "",
            "sysPath": path,
            "authorized": is_authorized,
            "interfaces": ["thunderbolt"],
            "mountPoint": "",
            "sizeBytes": 0,
            "dmaCapable": True,
            "firstSeen": now_iso(),
            "whitelisted": False,
        }
        devices.append(device)

    return devices


def scan_bluetooth_devices():
    """Scan for Bluetooth devices via hciconfig/bluetoothctl."""
    devices = []
    # Check if Bluetooth controller exists
    hci_out = run(["hciconfig", "-a"], timeout=5)
    if not hci_out:
        return devices

    # Parse hci devices
    for match in re.finditer(r'(hci\d+).*?BD Address: ([0-9A-Fa-f:]+)', hci_out, re.DOTALL):
        hci_dev, bd_addr = match.group(1), match.group(2)
        # Get paired/trusted devices via btmgmt or bluetoothctl
        devices_out = run(["bluetoothctl", "devices"], timeout=5)
        for dev_match in re.finditer(r'Device ([0-9A-Fa-f:]+) (.+)', devices_out):
            dev_addr, dev_name = dev_match.group(1), dev_match.group(2)
            # Check if trusted
            info_out = run(["bluetoothctl", "info", dev_addr], timeout=3)
            trusted = "Trusted: yes" in info_out
            paired = "Paired: yes" in info_out

            device = {
                "id": f"/sys/bluetooth/{dev_addr}",
                "name": dev_name,
                "vendor": "Bluetooth",
                "vendorId": "",
                "productId": dev_addr,
                "serial": dev_addr,
                "busType": "bluetooth",
                "driver": "btusb",
                "devPath": "",
                "sysPath": f"/sys/bluetooth/{dev_addr}",
                "authorized": trusted,
                "interfaces": ["bluetooth"],
                "mountPoint": "",
                "sizeBytes": 0,
                "dmaCapable": False,
                "firstSeen": now_iso(),
                "whitelisted": trusted,
            }
            devices.append(device)

    return devices


def scan_pci_devices():
    """Scan for recently-added PCI devices via lspci."""
    devices = []
    lspci_out = run(["lspci", "-mn"], timeout=5)
    if not lspci_out:
        return devices

    for line in lspci_out.splitlines():
        # Format: domain:bus:dev.func "class" "vendor" "device" ...
        m = re.match(r'([\d:.]+)\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"', line)
        if not m:
            continue
        pci_addr, pci_class, vendor_id, device_id = m.groups()

        # Only flag unusual devices — skip common classes (VGA, network, storage, USB host)
        skip_classes = {"0300", "0200", "0100", "0106", "0108", "0c03"}
        if pci_class.replace(" ", "") in skip_classes:
            continue

        # Get human-readable name
        desc_out = run(["lspci", "-s", pci_addr], timeout=3)
        name = desc_out.split(": ", 1)[-1].strip() if ": " in desc_out else f"PCI Device {device_id}"

        device = {
            "id": f"/sys/bus/pci/devices/{pci_addr}",
            "name": name,
            "vendor": vendor_id,
            "vendorId": vendor_id,
            "productId": device_id,
            "serial": "",
            "busType": "pci",
            "driver": "",
            "devPath": "",
            "sysPath": f"/sys/bus/pci/devices/{pci_addr}",
            "authorized": True,
            "interfaces": [],
            "mountPoint": "",
            "sizeBytes": 0,
            "dmaCapable": True,  # PCI devices can do DMA
            "firstSeen": now_iso(),
            "whitelisted": False,
        }
        devices.append(device)

    return devices


# ── Alert Generation ────────────────────────────────────────

def generate_alerts(all_devices, policy, whitelist):
    """Generate alerts for devices that violate policy."""
    alerts = []
    alert_id = 0

    # Mark whitelist status
    for dev in all_devices:
        dev["whitelisted"] = is_whitelisted(dev, whitelist)

    for dev in all_devices:
        alert_id += 1
        name = dev["name"]
        bus = dev["busType"]

        # USB mass storage
        if bus == "usb" and "mass-storage" in dev["interfaces"]:
            if policy.get("blockUsbStorage") and not dev["whitelisted"]:
                alerts.append({
                    "id": f"hw-alert-{alert_id}",
                    "timestamp": now_iso(),
                    "category": "usb-storage",
                    "severity": "critical",
                    "status": "active",
                    "message": f"Foreign USB mass storage detected: {name} ({dev['vendor']}) at {dev['devPath'] or 'unknown device'}",
                    "device": dev,
                    "rule": "usb-storage-block",
                    "autoAction": "blocked" if policy.get("autoBlock") else None,
                })

        # USB non-storage (lower severity)
        elif bus == "usb" and not dev["whitelisted"]:
            alerts.append({
                "id": f"hw-alert-{alert_id}",
                "timestamp": now_iso(),
                "category": "usb-device",
                "severity": "medium",
                "status": "active",
                "message": f"Unknown USB device connected: {name} ({dev['vendor']})",
                "device": dev,
                "rule": "usb-device-monitor",
            })

        # Thunderbolt DMA
        if bus == "thunderbolt" and dev["dmaCapable"]:
            if policy.get("blockThunderboltDMA") and not dev["authorized"] and not dev["whitelisted"]:
                alerts.append({
                    "id": f"hw-alert-{alert_id}",
                    "timestamp": now_iso(),
                    "category": "thunderbolt-dma",
                    "severity": "critical",
                    "status": "active",
                    "message": f"Unauthorized DMA-capable Thunderbolt device: {name} ({dev['vendor']})",
                    "device": dev,
                    "rule": "thunderbolt-dma-block",
                    "autoAction": "blocked" if policy.get("autoBlock") else None,
                })

        # Bluetooth anomalies
        if bus == "bluetooth" and not dev["authorized"] and policy.get("blockUnknownBluetooth"):
            alerts.append({
                "id": f"hw-alert-{alert_id}",
                "timestamp": now_iso(),
                "category": "bluetooth",
                "severity": "high",
                "status": "active",
                "message": f"Untrusted Bluetooth device paired: {name} ({dev['serial']})",
                "device": dev,
                "rule": "bluetooth-untrusted",
            })

        # PCI device anomalies
        if bus == "pci" and not dev["whitelisted"] and policy.get("blockUnknownPCI"):
            alerts.append({
                "id": f"hw-alert-{alert_id}",
                "timestamp": now_iso(),
                "category": "pci-device",
                "severity": "medium",
                "status": "active",
                "message": f"Unknown PCI device present: {name} (vendor={dev['vendorId']})",
                "device": dev,
                "rule": "pci-device-monitor",
            })

    return alerts


# ── Commands ────────────────────────────────────────────────

def cmd_summary():
    """Full alert summary with all devices and policy."""
    policy = load_policy()
    whitelist = load_whitelist()

    all_devices = []
    all_devices.extend(scan_usb_devices())
    all_devices.extend(scan_thunderbolt_devices())
    all_devices.extend(scan_bluetooth_devices())
    # PCI scan is optional — can be noisy
    # all_devices.extend(scan_pci_devices())

    alerts = generate_alerts(all_devices, policy, whitelist)

    active = [a for a in alerts if a["status"] == "active"]
    critical = [a for a in alerts if a["severity"] == "critical"]
    unauthorized = [d for d in all_devices if not d["whitelisted"]]

    return {
        "alerts": alerts,
        "activeCount": len(active),
        "criticalCount": len(critical),
        "totalDevices": len(all_devices),
        "unauthorizedDevices": len(unauthorized),
        "whitelistedDevices": len(all_devices) - len(unauthorized),
        "policy": policy,
        "whitelist": whitelist,
    }


def cmd_devices():
    """List all detected hardware devices."""
    all_devices = []
    all_devices.extend(scan_usb_devices())
    all_devices.extend(scan_thunderbolt_devices())
    all_devices.extend(scan_bluetooth_devices())
    return {"devices": all_devices, "count": len(all_devices)}


def cmd_alerts():
    """List active alerts only."""
    summary = cmd_summary()
    return {"alerts": summary["alerts"], "activeCount": summary["activeCount"]}


def cmd_acknowledge(alert_id):
    """Acknowledge an alert (would persist to state in production)."""
    return {"action": "acknowledge", "alertId": alert_id, "status": "acknowledged"}


def cmd_dismiss(alert_id):
    """Dismiss an alert."""
    return {"action": "dismiss", "alertId": alert_id, "status": "dismissed"}


def _device_path_ok(device_id):
    """v0.1.4 SECURITY: device ids from the scanners are absolute sysfs
    paths (/sys/bus/usb/devices/..., /sys/bus/thunderbolt/devices/...,
    /sys/bus/pci/devices/...). block/unblock write to <id>/authorized as
    root, so the id must resolve inside one of those scanned bases —
    anything else would make cmd_block an arbitrary file-overwrite ('0')
    and cmd_unblock a shell-injection primitive. The cockpit superuser
    channel escalates this helper via polkit; no sudo shell-out exists
    anywhere in this helper."""
    if not isinstance(device_id, str) or not device_id.startswith("/"):
        return False
    bases = (
        "/sys/bus/usb/devices",
        "/sys/bus/thunderbolt/devices",
        "/sys/bus/pci/devices",
    )
    p = os.path.realpath(device_id)
    return any(p == b or p.startswith(b + "/") for b in bases)


def cmd_block(device_id):
    """Block a device — for USB, writes '0' to authorized sysfs."""
    if not _device_path_ok(device_id):
        return {"action": "block", "deviceId": device_id, "result": "invalid-device-path"}
    auth_path = os.path.join(device_id, "authorized")
    if os.path.exists(auth_path):
        try:
            with open(auth_path, 'w') as f:
                f.write('0')
            return {"action": "block", "deviceId": device_id, "result": "blocked", "method": "usb-authorize"}
        except (PermissionError, OSError) as exc:
            return {"action": "block", "deviceId": device_id, "result": "error",
                    "error": str(exc)}
    return {"action": "block", "deviceId": device_id, "result": "no-method-available"}


def cmd_unblock(device_id):
    """Unblock a device."""
    if not _device_path_ok(device_id):
        return {"action": "unblock", "deviceId": device_id, "result": "invalid-device-path"}
    auth_path = os.path.join(device_id, "authorized")
    if os.path.exists(auth_path):
        # Direct write, never a shell: the helper already runs
        # privileged through the cockpit superuser channel when the
        # operator approves polkit.
        try:
            with open(auth_path, 'w') as f:
                f.write('1')
            return {"action": "unblock", "deviceId": device_id, "result": "unblocked"}
        except (PermissionError, OSError) as exc:
            return {"action": "unblock", "deviceId": device_id, "result": "error",
                    "error": str(exc)}
    return {"action": "unblock", "deviceId": device_id, "result": "no-method-available"}


def cmd_whitelist(device_id):
    """Add a device to the whitelist."""
    whitelist = load_whitelist()
    # Find device in current scan
    all_devices = []
    all_devices.extend(scan_usb_devices())
    all_devices.extend(scan_thunderbolt_devices())
    all_devices.extend(scan_bluetooth_devices())

    for dev in all_devices:
        if dev["id"] == device_id:
            entry = {
                "id": f"wl-{len(whitelist)+1}",
                "vendorId": dev["vendorId"],
                "productId": dev["productId"],
                "serial": dev["serial"],
                "name": dev["name"],
                "busType": dev["busType"],
                "addedAt": now_iso(),
                "addedBy": "sysdeck",
            }
            whitelist.append(entry)
            save_whitelist(whitelist)
            return {"action": "whitelist", "device": dev["name"], "entry": entry}

    return {"action": "whitelist", "deviceId": device_id, "result": "device-not-found"}


def cmd_unwhitelist(device_id):
    """Remove one device from the whitelist by exact identity.

    Match on exact serial, exact device id, or exact vendorId:productId —
    never a substring, which would remove every entry sharing a letter.
    """
    whitelist = load_whitelist()
    new_wl = [
        entry for entry in whitelist
        if not (
            device_id == entry.get("serial")
            or device_id == entry.get("id")
            or device_id == entry.get("deviceId")
            or device_id == f"{entry.get('vendorId', '')}:{entry.get('productId', '')}"
        )
    ]
    save_whitelist(new_wl)
    return {"action": "unwhitelist", "deviceId": device_id, "remaining": len(new_wl)}


def cmd_policy(key, value):
    """Update a policy toggle."""
    policy = load_policy()
    if key in policy:
        policy[key] = value.lower() in ("true", "1", "yes")
        save_policy(policy)
        return {"action": "policy", "key": key, "value": policy[key], "policy": policy}
    return {"error": f"Unknown policy key: {key}"}


# ── Main ────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(json.dumps(cmd_summary()))
        return

    cmd = sys.argv[1]

    if cmd == "summary":
        print(json.dumps(cmd_summary()))
    elif cmd == "devices":
        print(json.dumps(cmd_devices()))
    elif cmd == "alerts":
        print(json.dumps(cmd_alerts()))
    elif cmd == "acknowledge":
        aid = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_acknowledge(aid)))
    elif cmd == "dismiss":
        aid = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_dismiss(aid)))
    elif cmd == "block":
        did = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_block(did)))
    elif cmd == "unblock":
        did = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_unblock(did)))
    elif cmd == "whitelist":
        did = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_whitelist(did)))
    elif cmd == "unwhitelist":
        did = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_unwhitelist(did)))
    elif cmd == "policy":
        key = sys.argv[2] if len(sys.argv) > 2 else ""
        val = sys.argv[3] if len(sys.argv) > 3 else ""
        print(json.dumps(cmd_policy(key, val)))
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))


if __name__ == "__main__":
    main()
