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


def turn(text):
    event('user_turn', text=text)
    event('tool_call', text='fs_read')
    event('usage', inputTokens=10, outputTokens=4)
    time.sleep(float(os.getenv('FAKE_TURN_DELAY', '0')))
    event('assistant_turn', text='echo: ' + text, stopReason='end_turn')

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
