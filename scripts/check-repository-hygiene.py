#!/usr/bin/env python3
"""Fail CI on accidental agent command-token files and tracked local build logs.

Only source-tree files are inspected. Do not infer that other legacy sources
are unused; these require separate build/provenance comparison.
"""
import subprocess
from pathlib import Path
import sys

repo=Path(__file__).resolve().parent.parent
paths=subprocess.check_output([
    "git","-C",str(repo),"ls-files","-z",
    "--","native/agent/Agent/chatpass_agent",
]).decode("utf-8").split("\0")
bad=[]
for path in filter(None,paths):
    p=repo/path
    if not p.is_file():
        bad.append((path,"tracked file absent from worktree"))
    elif p.stat().st_size==0:
        bad.append((path,"empty/accidental agent command-token file"))
    elif p.name in ("build-sign-log.txt","$null"):
        bad.append((path,"generated local build/terminal output"))
if bad:
    for path,reason in bad:
        print("FAIL:",path,"-",reason,file=sys.stderr)
    sys.exit(1)
print("PASS: no tracked empty command-token files or generated build logs in native agent source.")
