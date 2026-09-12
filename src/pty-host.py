#!/usr/bin/env python3
"""The pty the server owns for an interactive run (agentry-mcp M5, D6).

    pty-host.py COLS ROWS -- COMMAND [ARG...]

Forks COMMAND on a new pseudo-terminal of COLS x ROWS, then pumps: this
process's stdin (a pipe from the server) into the pty, and everything the
pty says onto stdout, byte for byte. SIGINT and SIGTERM are passed to the
child; the exit status is the child's. No shell is involved: the argv is
executed as given. Python's pty module is used because the server runs
wherever the CLI does without a native addon of its own.
"""

import fcntl
import os
import select
import signal
import struct
import sys
import termios

if len(sys.argv) < 5 or sys.argv[3] != "--":
    sys.stderr.write(__doc__)
    sys.exit(2)
cols, rows = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[4:]

import pty  # noqa: E402

pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def forward(sig, _frame):
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGINT, forward)
signal.signal(signal.SIGTERM, forward)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
stdin_open = True
while True:
    fds = [fd] + ([stdin_fd] if stdin_open else [])
    try:
        r, _, _ = select.select(fds, [], [], 0.5)
    except InterruptedError:
        continue
    if fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        os.write(stdout_fd, chunk)
    if stdin_fd in r:
        chunk = os.read(stdin_fd, 65536)
        if not chunk:
            stdin_open = False
            continue
        os.write(fd, chunk)
    done, status = os.waitpid(pid, os.WNOHANG)
    if done == pid:
        # Drain what the pty still holds, then leave.
        while True:
            try:
                r, _, _ = select.select([fd], [], [], 0.2)
            except InterruptedError:
                continue
            if not r:
                break
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            os.write(stdout_fd, chunk)
        os.close(fd)
        if os.WIFSIGNALED(status):
            sys.exit(128 + os.WTERMSIG(status))
        sys.exit(os.WEXITSTATUS(status))
try:
    _, status = os.waitpid(pid, 0)
except ChildProcessError:
    sys.exit(0)
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(os.WEXITSTATUS(status))
