#!/usr/bin/env python3
"""Compute npm transitive closure with hashes for linear-mcp-server@0.1.0"""
import json, subprocess, sys, os, hashlib
from pathlib import Path

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, shell=True)
    if r.returncode != 0:
        print(f"ERR: {cmd}", file=sys.stderr)
        print(r.stderr, file=sys.stderr)
        return None
    return r.stdout.strip()

# Create temp directory
tmp = Path(os.environ.get("TMPDIR", "/tmp")) / "jarod-linear-closure"
tmp.mkdir(parents=True, exist_ok=True)
os.chdir(tmp)

# Initialize package.json with just linear-mcp-server
pkg = {"dependencies": {"linear-mcp-server": "0.1.0"}}
(tmp / "package.json").write_text(json.dumps(pkg, indent=2))

# Install with --package-lock-only to get full tree without node_modules
print("Computing npm closure...", file=sys.stderr)
r = subprocess.run(["npm", "install", "--package-lock-only", "--legacy-peer-deps"], capture_output=True, text=True)
if r.returncode != 0:
    print("npm install failed:", r.stderr, file=sys.stderr)
    sys.exit(1)

# Read package-lock.json
lock = json.loads((tmp / "package-lock.json").read_text())

# Extract all dependencies with integrity
results = []
def extract_deps(obj, prefix=""):
    if "dependencies" in obj:
        for name, info in obj["dependencies"].items():
            version = info.get("version", "")
            integrity = info.get("integrity", "")
            resolved = info.get("resolved", "")
            # Extract sha512 from integrity
            sha512 = ""
            if integrity.startswith("sha512-"):
                sha512 = integrity[8:]  # Remove "sha512-"
            elif integrity.startswith("sha1-"):
                sha512 = f"sha1:{integrity[5:]}"
            results.append({
                "name": name,
                "version": version,
                "integrity": integrity,
                "sha512": sha512,
                "resolved": resolved,
                "dev": info.get("dev", False),
                "optional": info.get("optional", False)
            })
            if "dependencies" in info:
                extract_deps(info, prefix + "  ")

extract_deps(lock)

# Sort by name
results.sort(key=lambda x: x["name"].lower())

# Output
print(f"# npm transitive closure for linear-mcp-server@0.1.0")
print(f"# Generated: {__import__('datetime').datetime.now().isoformat()}")
print(f"# Total packages: {len(results)}")
print()
for r in results:
    if r["dev"]:
        continue  # Skip dev dependencies for production
    print(f"{r['name']}@{r['version']}  integrity={r['integrity']}  resolved={r['resolved']}")

# Also write JSON for processing
(tmp / "closure.json").write_text(json.dumps(results, indent=2))
print(f"\n# Full JSON written to {tmp}/closure.json", file=sys.stderr)