#!/usr/bin/env python3
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
extension_path = root / 'extension.js'
extension = extension_path.read_text(encoding='utf-8')
pattern = re.compile(r"function redactUrl\(url\)\{.*?\n\}", re.S)
replacement = """function redactUrl(url){
  try {
    const value = new URL(url);
    value.username = '';
    value.password = '';
    value.search = '';
    value.hash = '';
    return value.toString();
  } catch {
    return '';
  }
}"""
extension, count = pattern.subn(replacement, extension, count=1)
if count != 1:
    raise RuntimeError('Could not replace URL sanitization')
if "searchParams.set('token'" in extension or '?token=' in extension:
    raise RuntimeError('VS Code runtime still contains query-token compatibility')
extension_path.write_text(extension.rstrip() + '\n', encoding='utf-8')

Path(__file__).unlink()
print('Removed query-token compatibility from URL sanitization.')
