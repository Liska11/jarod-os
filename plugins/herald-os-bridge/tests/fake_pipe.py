"""A Windows named-pipe server for the fake shells, in plain ctypes (no pywin32).

The shell's Windows door is a named pipe (``pipe://<name>``, opened by the bridge as ``\\\\.\\pipe\\<name>``).
The fake shells used to serve only a Unix socket, so 18 protocol tests were skipped on Windows. This server
answers one JSON line per connection, like the shell, with whatever ``handle`` returns for the bytes it read.
"""

from __future__ import annotations

import ctypes
import threading
import uuid
from ctypes import wintypes
from typing import Callable

PIPE_ACCESS_DUPLEX = 0x00000003
PIPE_TYPE_BYTE = 0x00000000
PIPE_WAIT = 0x00000000
PIPE_UNLIMITED_INSTANCES = 255
ERROR_PIPE_CONNECTED = 535
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
GENERIC_READ_WRITE = 0xC0000000
OPEN_EXISTING = 3

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_k32.CreateNamedPipeW.restype = wintypes.HANDLE
_k32.CreateNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID]
_k32.ConnectNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
_k32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
_k32.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
_k32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
_k32.DisconnectNamedPipe.argtypes = [wintypes.HANDLE]
_k32.CloseHandle.argtypes = [wintypes.HANDLE]
_k32.CreateFileW.restype = wintypes.HANDLE
_k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]


class PipeServer:
    """Serves ``\\\\.\\pipe\\<random name>`` until ``close``; ``endpoint`` is the ``pipe://<name>`` form the bridge reads."""

    def __init__(self, handle: Callable[[bytes], bytes]):
        self.handle = handle
        self.name = f"hos-test-{uuid.uuid4().hex}"
        self.path = f"\\\\.\\pipe\\{self.name}"
        self.endpoint = f"pipe://{self.name}"
        self._stopped = False
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._serve, name="fake-shell-pipe", daemon=True)
        self._thread.start()
        self._ready.wait(5)

    def _instance(self) -> int:
        h = _k32.CreateNamedPipeW(self.path, PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_WAIT, PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, None)
        if h == INVALID_HANDLE_VALUE:
            raise OSError(ctypes.get_last_error(), "CreateNamedPipeW failed")
        return h

    def _serve(self) -> None:
        pipe = self._instance()
        self._ready.set()  # an instance exists: a client may open the pipe from now on
        while True:
            if not _k32.ConnectNamedPipe(pipe, None) and ctypes.get_last_error() != ERROR_PIPE_CONNECTED:
                _k32.CloseHandle(pipe)
                if self._stopped:
                    return
                pipe = self._instance()
                continue
            if self._stopped:
                _k32.DisconnectNamedPipe(pipe)
                _k32.CloseHandle(pipe)
                return
            # The next instance exists before this one is answered, so a quick second client never finds no pipe.
            following = self._instance()
            try:
                data = b""
                buf = ctypes.create_string_buffer(65536)
                read = wintypes.DWORD(0)
                while not data.endswith(b"\n"):
                    if not _k32.ReadFile(pipe, buf, 65536, ctypes.byref(read), None) or read.value == 0:
                        break
                    data += buf.raw[: read.value]
                if data:
                    answer = self.handle(data)
                    written = wintypes.DWORD(0)
                    _k32.WriteFile(pipe, answer, len(answer), ctypes.byref(written), None)
                    _k32.FlushFileBuffers(pipe)
            finally:
                _k32.DisconnectNamedPipe(pipe)
                _k32.CloseHandle(pipe)
            pipe = following

    def close(self) -> None:
        self._stopped = True
        # Wake the waiting ConnectNamedPipe with a client of our own, then let the loop end.
        h = _k32.CreateFileW(self.path, GENERIC_READ_WRITE, 0, None, OPEN_EXISTING, 0, None)
        if h != INVALID_HANDLE_VALUE:
            _k32.CloseHandle(h)
        self._thread.join(5)
