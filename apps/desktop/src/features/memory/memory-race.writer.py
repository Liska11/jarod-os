"""One Hermes process for memory-race.test.ts (V-20, upstream #140): adds `count` entries to $HERMES_HOME/memories/MEMORY.md.

Usage: memory-race.writer.py <prefix> <count> [Hermes checkout]

Starts once MEMORY.md exists, so its writes overlap those of the Jarod-OS process that creates it.

With a Hermes checkout, entries go through Hermes's own MemoryStore.add. Without one, a minimal writer does what
MemoryStore._mutate does: lock MEMORY.md.lock (flock, or msvcrt.locking of the first byte on Windows), read, append,
then an atomic replace through a .mem_*.tmp temporary.
"""

import os
import sys
import tempfile
import time
from pathlib import Path

ENTRY_DELIMITER = "\n§\n"

try:
    import fcntl

    def lock(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_EX)

    def unlock(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_UN)

except ImportError:
    import msvcrt

    def lock(fd: int) -> None:
        os.lseek(fd, 0, 0)
        while True:
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                time.sleep(0.002)

    def unlock(fd: int) -> None:
        os.lseek(fd, 0, 0)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)


def replace(tmp: str, path: Path) -> None:
    # Windows refuses a replace for an instant while another process has the target open (it is read without the lock).
    for attempt in range(50):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.005 * (attempt + 1))
    os.replace(tmp, path)


def minimal_add(path: Path, content: str) -> None:
    lock_path = path.with_suffix(path.suffix + ".lock")
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        lock(fd)
        try:
            raw = path.read_text(encoding="utf-8") if path.exists() else ""
            entries = [e for e in (x.strip() for x in raw.split(ENTRY_DELIMITER)) if e]
            tmp_fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".mem_", suffix=".tmp")
            with os.fdopen(tmp_fd, "w", encoding="utf-8", newline="") as tmp_file:
                tmp_file.write(ENTRY_DELIMITER.join(entries + [content]))
                tmp_file.flush()
                os.fsync(tmp_file.fileno())
            replace(tmp, path)
        finally:
            unlock(fd)
    finally:
        os.close(fd)


def main() -> None:
    prefix, count = sys.argv[1], int(sys.argv[2])
    checkout = sys.argv[3] if len(sys.argv) > 3 else None
    memories = Path(os.environ["HERMES_HOME"]) / "memories"
    memories.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 20
    while not (memories / "MEMORY.md").exists() and time.monotonic() < deadline:
        time.sleep(0.001)

    if checkout:
        sys.path.insert(0, checkout)
        from tools.memory_tool_store import MemoryStore

        store = MemoryStore(memory_char_limit=10**8, user_char_limit=10**8)
        store.load_from_disk()
        for i in range(count):
            result = store.add("memory", f"{prefix}-{i}")
            if not result.get("success"):
                raise SystemExit(f"Hermes refused {prefix}-{i}: {result.get('error')}")
    else:
        for i in range(count):
            minimal_add(memories / "MEMORY.md", f"{prefix}-{i}")


if __name__ == "__main__":
    main()
