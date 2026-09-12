#!/usr/bin/env python3
"""The pty the server owns for an interactive run (agentry-mcp M5, D6).

    pty-host.py COLS ROWS -- COMMAND [ARG...]

Forks COMMAND on a new pseudo-terminal of COLS x ROWS, then pumps: this
process's stdin (a pipe from the server) into the pty, and everything the
pty says onto stdout, byte for byte. SIGINT and SIGTERM are passed to the
child; the exit status is the child's (128 + the signal when it died by
one; 127 when it could not be started). No shell is involved: the argv is
executed as given. Python's pty module is used because the server runs
wherever the CLI does without a native addon of its own.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CHUNK = 65536


def exit_with(status):
    """Leave with the child's outcome as this process's exit code."""
    if os.WIFSIGNALED(status):
        sys.exit(128 + os.WTERMSIG(status))
    sys.exit(os.WEXITSTATUS(status))


def main():
    if len(sys.argv) < 5 or sys.argv[3] != "--":
        sys.stderr.write(__doc__)
        sys.exit(2)
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[4:]

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError as err:
            sys.stderr.write("pty-host: cannot start %s: %s\n" % (argv[0], err))
            os._exit(127)

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
        r, _, _ = select.select(fds, [], [], 0.5)
        if fd in r:
            try:
                chunk = os.read(fd, CHUNK)
            except OSError:
                # EIO: the child closed its side; it has exited or is about to.
                chunk = b""
            if not chunk:
                break
            os.write(stdout_fd, chunk)
        if stdin_fd in r:
            try:
                chunk = os.read(stdin_fd, CHUNK)
            except OSError:
                chunk = b""
            if not chunk:
                # The server closed its pipe; the child keeps the terminal.
                stdin_open = False
                continue
            os.write(fd, chunk)
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            # Drain what the pty still holds, then leave.
            while True:
                r, _, _ = select.select([fd], [], [], 0.2)
                if not r:
                    break
                try:
                    chunk = os.read(fd, CHUNK)
                except OSError:
                    break
                if not chunk:
                    break
                os.write(stdout_fd, chunk)
            os.close(fd)
            exit_with(status)
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        # Reaped elsewhere: the outcome is unknown, which is not success.
        sys.exit(1)
    exit_with(status)


if __name__ == "__main__":
    main()
