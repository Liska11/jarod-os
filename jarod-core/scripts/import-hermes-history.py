#!/usr/bin/env python3
"""Import Hermes history into Jarod (dry-run first, then apply).
 *  Reads Hermes state.db, creates a Jarod-compatible bundle, runs PortabilityService.apply().
 *  Usage: python scripts/import-hermes-history.py [--apply] [--approve-mcp] [--limit N]
"""
import sqlite3
import json
import os
import sys
import shutil
import subprocess
from pathlib import Path
from datetime import datetime

HERMES_DB = r"C:\Users\San\AppData\Local\hermes\state.db"
JAROD_PROFILE_DIR = r"S:\store\projet\jarod-cordis\data\profiles\default"
BUNDLE_DIR = r"S:\store\projet\jarod-cordis\.work\hermes-import-bundle"

# Keys that Jarod's PortabilityService will accept (from IMPORTABLE_SETTINGS)
IMPORTABLE_SETTINGS = {
    "language", "theme", "activeProvider", "activeModel", "fallbacks",
    "thinking", "effort", "memoryInject", "autoTitle", "compactThreshold",
    "maxAgentSteps", "toolSearch", "browserVisible"
}

# Settings that require approval (APPROVAL_SETTINGS)
APPROVAL_SETTINGS = {"mcpServers"}

def connect_hermes():
    conn = sqlite3.connect(HERMES_DB)
    conn.row_factory = sqlite3.Row
    return conn

def extract_sessions(conn, limit=None):
    """Extract sessions with their messages."""
    cursor = conn.cursor()
    query = """
        SELECT s.id, s.title, s.started_at as created_at, s.last_activity_at as updated_at,
               s.model, s.model as provider,
               s.system_prompt, s.parent_session_id as parent_id
        FROM sessions s
        WHERE s.archived = 0
        ORDER BY s.started_at
    """
    if limit:
        query += f" LIMIT {limit}"
    sessions = [dict(row) for row in cursor.execute(query).fetchall()]
    
    # Get messages for each session
    for session in sessions:
        cursor.execute("""
            SELECT m.id, m.session_id, m.role, m.content, m.timestamp as created_at,
                   m.token_count as input_tokens, 0 as output_tokens, 0 as cache_read_tokens, 0 as cache_write_tokens,
                   s.model as model, s.model as provider, m.finish_reason, m.tool_calls
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE m.session_id = ? AND m.active = 1
            ORDER BY m.timestamp
        """, (session["id"],))
        session["messages"] = [dict(row) for row in cursor.fetchall()]
    
    return sessions

def extract_settings(conn):
    """Extract relevant settings from Hermes config."""
    # Hermes stores config in various places; for now we'll create a minimal settings object
    # The actual Hermes config.yaml has the settings
    import yaml
    config_path = r"C:\Users\San\AppData\Local\hermes\config.yaml"
    if os.path.exists(config_path):
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    return {}

def create_bundle(sessions, settings, output_dir):
    """Create a Jarod-compatible bundle directory."""
    bundle_path = Path(output_dir)
    if bundle_path.exists():
        shutil.rmtree(bundle_path)
    bundle_path.mkdir(parents=True)
    (bundle_path / "personas").mkdir(parents=True)
    
    # 1. Manifest
    manifest = {
        "version": 1,
        "at": int(datetime.now().timestamp() * 1000),
        "profile": "default",
        "profiles": ["default"],
        "counts": {
            "memory": len(sessions),
            "settings": 0,
            "personas": 0
        },
        "redacted": []
    }
    (bundle_path / "manifest.json").write_text(json.dumps(manifest, indent=2))
    
    # 2. Memory (sessions as memories)
    memories = []
    for session in sessions:
        # Create a memory entry per session with title + first user message
        content_parts = [f"Session: {session.get('title', 'Sans titre')}"]
        for msg in session.get("messages", []):
            if msg["role"] == "user":
                content_parts.append(f"User: {msg['content'][:500]}")
            elif msg["role"] == "assistant":
                content_parts.append(f"Assistant: {msg['content'][:500]}")
        content = "\n\n".join(content_parts)
        memories.append({
            "content": content,
            "type": "session"
        })
    
    (bundle_path / "memory.json").write_text(json.dumps(memories, indent=2))
    
    # 3. Settings (filtered to importable)
    importable = {}
    for key in IMPORTABLE_SETTINGS:
        if key in settings:
            importable[key] = settings[key]
    (bundle_path / "settings.json").write_text(json.dumps(importable, indent=2))
    
    # 4. Personas (if any)
    # Could extract from Hermes system_prompts table
    
    return bundle_path

def apply_bundle(bundle_dir, approve_mcp=False):
    """Apply the bundle using Jarod's PortabilityService via the CLI."""
    cmd = [
        "node",
        "--import=tsx",
        "packages/cli/src/main.ts",
        "portability",
        "apply",
        str(bundle_dir),
        "--profile", "default"
    ]
    if approve_mcp:
        cmd.append("--approve-mcp")
    
    env = os.environ.copy()
    env["NODE_PATH"] = "S:/store/projet/jarod-cordis"
    
    print(f"   Commande: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=r"S:\store\projet\jarod-cordis", 
                          capture_output=True, text=True, timeout=120, env=env)
    if result.returncode != 0:
        print(f"   ❌ Erreur: {result.stderr}")
        return False
    print(f"   ✅ Sortie: {result.stdout}")
    return True

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Apply the import (default: dry-run/inspect)")
    parser.add_argument("--approve-mcp", action="store_true", help="Approve mcpServers import")
    parser.add_argument("--limit", type=int, default=None, help="Limit sessions for testing")
    args = parser.parse_args()
    
    print("=" * 60)
    print("IMPORT HERMES HISTORY → JAROD")
    print("=" * 60)
    print(f"Source: {HERMES_DB}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN (inspect only)'}")
    print()
    
    conn = connect_hermes()
    print("📖 Lecture sessions Hermes...")
    sessions = extract_sessions(conn, limit=args.limit)
    print(f"   {len(sessions)} sessions, total messages: {sum(len(s['messages']) for s in sessions)}")
    
    print("📖 Lecture settings...")
    settings = extract_settings(conn)
    print(f"   Clés trouvées: {list(settings.keys())[:10]}...")
    
    print(f"\n📦 Création bundle dans {BUNDLE_DIR}...")
    bundle_dir = create_bundle(sessions, settings, BUNDLE_DIR)
    print(f"   OK: {bundle_dir}")
    
    # Now use Jarod's PortabilityService via the kernel
    # We'll invoke the inspect/apply via the CLI or directly
    print("\n🔍 Inspection via PortabilityService...")
    
    # For now, just show what would be imported
    print(f"\n📊 RÉSUMÉ DRY-RUN:")
    print(f"   Sessions à importer: {len(sessions)}")
    print(f"   Messages totaux: {sum(len(s['messages']) for s in sessions)}")
    print(f"   Réglages importables: {len(IMPORTABLE_SETTINGS)}")
    print(f"   Réglages à approuver: {len(APPROVAL_SETTINGS)}")
    print(f"   Bundle prêt dans: {bundle_dir}")
    
    if args.apply:
        print("\n🚀 APPLICATION DU BUNDLE...")
        if apply_bundle(bundle_dir, approve_mcp=args.approve_mcp):
            print("✅ Import appliqué avec succès")
        else:
            print("❌ Échec de l'import")
            sys.exit(1)
    else:
        print("\n✅ Dry-run terminé. Pour appliquer: --apply [--approve-mcp]")

if __name__ == "__main__":
    main()