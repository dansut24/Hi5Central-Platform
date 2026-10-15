#!/usr/bin/env python3
"""Read-only QA API Compose preflight. Never prints credentials or Compose JSON.

Run only in the authorized SSH administrator session on the real VPS. Nothing
is deployed or modified. Refuses any unexpected change besides the image and
two new dedicated release-publication environment variables.
"""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SHA="9f3cb1da7c27ba3f9846c23bd6d9e557fe6267f0"
EXPECTED_API_IMAGE="ghcr.io/dansut24/hi5central-platform-api:sha-2199e58a540ff912cccdbd137fdfbb9e8d48f3c5"
EXPECTED_ROLLBACK_ID="sha256:237637f2db12879ed9c3ab7f0d86e305607ae2c18984d38fb0e95192d32f8b56"
CANDIDATE="hi5central-api:qa-publication-auth-fdee74c"
EXPECTED_CANDIDATE_ID="sha256:685d076d9efccbf047b5391182df43b9b80e3ec23b977ed96a6d7b2f2fd2f581"
EXPECTED_FILES=[
    "/opt/hi5central/deployment/compose.runtime.yml",
    "/opt/hi5central/phase43-live-release-label/compose.prod.yml",
    "/opt/hi5central/deployment/compose.release-publication-2199e58.yml",
]
OVERLAY=Path(__file__).with_name("compose.live-publication-auth-only.overlay.yml")
ADDED=("RELEASE_PUBLICATION_TOKEN_SHA256","RELEASE_PUBLICATION_ALLOWED_SHA")


def fail(message):
    raise SystemExit("PUBLICATION_COMPOSE_PREFLIGHT_BLOCKED: "+message)


def command(args):
    completed=subprocess.run(args,capture_output=True,text=True,check=False,timeout=60)
    if completed.returncode:
        # Do not print stderr: compose interpolation errors may contain secrets.
        fail("Required Docker/Compose command failed; review locally without sharing secret output.")
    return completed.stdout


def config(files):
    cmd=["docker","compose"]
    for path in files:
        cmd.extend(("-f",str(path)))
    cmd.extend(("config","--format","json"))
    try:
        cfg=json.loads(command(cmd))
    except (ValueError,KeyError):
        fail("Docker Compose did not return valid configuration JSON.")
    service=cfg.get("services",{}).get("api")
    if not isinstance(service,dict):
        fail("The existing Compose project does not define service api.")
    return service


def environment(service):
    value=service.get("environment") or {}
    if isinstance(value,list):
        return dict(row.split("=",1) for row in value)
    if isinstance(value,dict):
        return value
    fail("Unexpected Compose API environment format.")


def main():
    if os.geteuid()!=0:
        fail("Run from the approved root SSH session.")
    digest=os.environ.get("RELEASE_PUBLICATION_TOKEN_SHA256","")
    if not re.fullmatch(r"[a-f0-9]{64}",digest):
        fail("Set the SHA-256 digest of the NEW publication token, not the bearer itself.")
    if not OVERLAY.is_file():
        fail("The reviewed overlay file is absent.")
    state=json.loads(command(["docker","inspect","hi5central-api"]))[0]
    labels=state["Config"]["Labels"]
    source=labels.get("com.docker.compose.project.config_files","").split(",")
    if source!=EXPECTED_FILES:
        fail("Live API compose source files differ from the reviewed list.")
    if labels.get("com.docker.compose.service")!="api":
        fail("Live API does not belong to the expected Compose service.")
    if state["Config"].get("Image")!=EXPECTED_API_IMAGE:
        fail("Live API has changed from the pinned rollback baseline.")
    if state["Image"]!=EXPECTED_ROLLBACK_ID:
        fail("Running Live API image ID differs from its reviewed rollback snapshot.")
    rollback=json.loads(command(["docker","image","inspect",EXPECTED_API_IMAGE]))[0]
    target=json.loads(command(["docker","image","inspect",CANDIDATE]))[0]
    if rollback["Id"]!=EXPECTED_ROLLBACK_ID or target["Id"]!=EXPECTED_CANDIDATE_ID:
        fail("Immutable rollback or candidate image changed.")

    base=config(EXPECTED_FILES)
    changed=config([*EXPECTED_FILES,OVERLAY])
    if base.get("image")!=EXPECTED_API_IMAGE:
        fail("Source Compose image no longer matches the running Live API.")
    if changed.get("image")!=CANDIDATE:
        fail("Candidate Compose image override is missing.")
    before=environment(base)
    after=environment(changed)
    if any(k in before for k in ADDED):
        fail("One of the new publication-only environment keys already exists in Live.")
    if after.get(ADDED[0])!=digest or after.get(ADDED[1])!=SHA:
        fail("The exact token digest and immutable build SHA were not supplied.")

    active={}
    for value in state["Config"].get("Env") or []:
        k,_,v=value.partition("=")
        active[k]=v
    if any(active.get(k)!=v for k,v in before.items()):
        fail("Original Compose environment differs from the running API; refuse a blind restart.")

    baseline=copy.deepcopy(base)
    candidate=copy.deepcopy(changed)
    baseline.pop("image",None)
    candidate.pop("image",None)
    candidate_env=environment(candidate)
    for k in ADDED:
        candidate_env.pop(k,None)
    candidate["environment"]=candidate_env
    baseline["environment"]=before
    if baseline!=candidate:
        fail("Existing API service settings would change beyond the reviewed image and two env keys.")

    networks=set(state["NetworkSettings"].get("Networks",{}))
    if not {"hi5central","hi5central-test_hi5internal","hi5central-uat_hi5internal"}.issubset(networks):
        fail("Actual Live API Docker network membership unexpectedly changed.")
    print("QA_LIVE_API_ONLY_COMPOSE_PREFLIGHT_PASS")
    print("Changed scope: api.image, api.environment.RELEASE_PUBLICATION_TOKEN_SHA256,")
    print("api.environment.RELEASE_PUBLICATION_ALLOWED_SHA")
    print("Existing API environment, networks and volumes unchanged in rendered Compose.")
    print("No deployment, credential disclosure or global rollout action occurred.")


if __name__=="__main__":
    try:
        main()
    except (OSError,TypeError,KeyError,IndexError,ValueError,subprocess.TimeoutExpired):
        fail("Unexpected inspect or Compose result; review locally, without exposing secrets.")
