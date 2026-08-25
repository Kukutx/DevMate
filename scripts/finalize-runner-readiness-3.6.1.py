from pathlib import Path

p = Path('tests/runner-readiness.test.mjs')
s = p.read_text(encoding='utf-8')
old = """}, config.connection.publicUrl, verificationStamp));"""
new = """}, config.connection.publicUrl, verificationStamp, null, null, 'oauth', 0, 0));"""
if s.count(old) != 1:
    raise SystemExit('Runner readiness verification fixture call not found exactly once')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('3.6.1 Runner readiness OAuth verification fixture aligned')
