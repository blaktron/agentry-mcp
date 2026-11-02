"""A fixture for `agentry agent attach --json`: stdin commands, fd 3 events; leaving detaches."""
import json
import os
import sys
import time

pipe = os.fdopen(3, 'w', buffering=1)


def event(kind, **kw):
    pipe.write(json.dumps(dict(kind=kind, **kw)) + '\n')


for line in sys.stdin:
    cmd = json.loads(line)
    if 'end' in cmd:
        break
    text = cmd['send']['text']
    if os.getenv('FAKE_AGENT_BUSY'):
        event('error', text='a turn is in flight; send again when its answer arrives', refused='busy')
        continue
    if os.getenv('FAKE_AGENT_STALE'):
        event('user_turn', text='another chat')
        event('assistant_turn', text='echo: another chat')
    event('user_turn', text=text)
    question = os.getenv('FAKE_AGENT_QUESTION')
    if question:
        event('question', question='q-1', text=question)
        # The person's answer comes back as a command; none comes when the
        # client leaves, and the turn goes on as if unanswered.
        reply = sys.stdin.readline()
        answer = json.loads(reply).get('answer') if reply.strip() else None
        if answer is None:
            break
        text = text + (' [answered yes]' if answer['yes'] else ' [answered no]')
    event('tool_call', text='read_share')
    event('usage', inputTokens=10, outputTokens=4, totalTokens=14)
    time.sleep(float(os.getenv('FAKE_TURN_DELAY', '0')))
    event('assistant_turn', text='echo: ' + text)
