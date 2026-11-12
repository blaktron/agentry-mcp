"""A CLI protocol fixture: stdin commands, fd 3 events, stdout envelope."""
import json
import os
import select
import sys
import time
from pathlib import Path

args = sys.argv[1:]
out = Path(args[args.index('--out') + 1])
pid_file = os.getenv('FAKE_SESSION_PID')
if pid_file:
    # Written whole before it is visible, so a reader never sees half a pid.
    Path(pid_file + '.tmp').write_text(str(os.getpid()))
    os.replace(pid_file + '.tmp', pid_file)
if os.getenv('FAKE_SESSION_FAIL_START'):
    print('agentry: gateway image not present', file=sys.stderr)
    sys.exit(13)
out.joinpath('receipts').mkdir(parents=True, exist_ok=True)
events = out / 'receipts' / 'events.ndjson'
events.touch()
pipe = os.fdopen(3, 'w', buffering=1)

def event(kind, **kw):
    ev = dict(kind=kind, **kw)
    line = json.dumps(ev)
    with events.open('a') as f:
        f.write(line + '\n')
    # Split an event to exercise stream decoding.
    pipe.write(line[:7])
    pipe.flush()
    pipe.write(line[7:] + '\n')


def end(reason):
    event('session_end', reason=reason)
    envelope = dict(status='ok', exitClass='ok', result='final: ' + reason)
    (out / 'result.json').write_text(json.dumps(envelope))
    (out / 'receipts' / 'transcript.md').write_text(events.read_text())
    print(json.dumps(envelope))
    sys.exit(0)


def steer(cmd, in_turn):
    """Answers a steer as the CLI does: the session's own steer event, or a refusal."""
    how = os.getenv('FAKE_STEER', '')
    if how == 'old-cli':
        event('error', refused='unknown_command', text='unknown command "steer" (want send, add, end or answer)')
    elif not in_turn:
        event('error', refused='no_turn', text='no turn is in flight; send the text as a turn')
    elif how == 'cannot':
        event('error', refused='cannot_steer', text='this harness takes no message while a turn is in flight: the docker-agent harness takes one only between turns')
    elif how == 'cap':
        event('error', refused='steer_refused', text="the session's limit of 3 messages is reached")
    else:
        event('steer', text=cmd['steer']['text'])
        event('steered')
        return cmd['steer']['text']
    return None


def turn(text):
    event('user_turn', text=text)
    event('tool_call', text='fs_read')
    event('usage', inputTokens=10, outputTokens=4)
    # While the tool runs, a steer may arrive; any other command waits.
    steered = []
    until = time.time() + float(os.getenv('FAKE_TURN_DELAY', '0'))
    while time.time() < until:
        if select.select([sys.stdin], [], [], max(0, min(0.05, until - time.time())))[0]:
            line = sys.stdin.readline()
            if not line:
                break
            cmd = json.loads(line)
            if 'steer' in cmd:
                taken = steer(cmd, True)
                if taken:
                    steered.append(taken)
            else:
                event('error', refused='busy', text='a turn is in flight')
    event('assistant_turn', text='echo: ' + ' + '.join([text] + steered), stopReason='end_turn')

if '--input' in args:
    opening = Path(args[args.index('--input') + 1]).read_text()
    if opening.strip():
        turn(opening)
while True:
    idle = float(os.getenv('FAKE_SESSION_IDLE', '0'))
    if idle and not select.select([sys.stdin], [], [], idle)[0]:
        end('idle_timeout')
    line = sys.stdin.readline()
    if not line:
        end('quit')
    cmd = json.loads(line)
    if 'end' in cmd:
        end('finished' if cmd['end']['finish'] else 'quit')
    elif 'steer' in cmd:
        steer(cmd, False)
    elif 'add' in cmd:
        if os.getenv('FAKE_INPUT_REFUSED'):
            event('error', refused='input_refused', text='fixture refused input')
        else:
            event('input_added', path=cmd['add']['path'])
            turn('input added: ' + Path(cmd['add']['path']).name)
    else:
        if os.getenv('FAKE_PROTOCOL_BUSY'):
            event('error', refused='busy', text='a turn is in flight')
        else:
            turn(cmd['send']['text'])
