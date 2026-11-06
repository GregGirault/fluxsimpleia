#!/usr/bin/env python3
"""Small, reproducible smoke tests for OpenAI-compatible chat-completion APIs.

Runs exactly one request. Not a reliability or model-quality benchmark.
Only uses Python's standard library.
"""

import argparse
import json
import os
import re
import sys
import time
from urllib import error, parse, request


class SmokecheckError(Exception):
    """A safe, user-readable smokecheck failure."""


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SmokecheckError("Provider redirected the request; inspect the endpoint manually.")


def completion_url(base_url):
    """Accept an OpenAI-compatible base URL such as https://host.example/v1."""
    parts = parse.urlsplit(base_url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SmokecheckError("Expected a valid HTTP(S) endpoint.")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise SmokecheckError("Do not include credentials, query strings or fragments in the endpoint.")
    if parts.scheme != "https" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise SmokecheckError("Remote API endpoints must use HTTPS.")
    prefix = parts.path.rstrip("/")
    if prefix.endswith("/chat/completions"):
        path = prefix
    elif prefix.endswith("/v1"):
        path = prefix + "/chat/completions"
    else:
        path = prefix + "/v1/chat/completions"
    return parse.urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def make_payload(model, mode):
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Respond exactly with PONG."},
            {"role": "user", "content": "Reply with PONG."},
        ],
        "temperature": 0,
        "max_tokens": 20,
    }
    if mode == "stream":
        payload["stream"] = True
    elif mode == "tool":
        payload["messages"] = [
            {"role": "user", "content": "Call echo with value ping. Do not answer in plain text."}
        ]
        payload["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": "echo",
                    "description": "Echo the supplied value.",
                    "parameters": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}},
                        "required": ["value"],
                        "additionalProperties": False,
                    },
                },
            }
        ]
        payload["tool_choice"] = {"type": "function", "function": {"name": "echo"}}
    return payload


def _parse_json(data):
    try:
        parsed = json.loads(data)
    except (ValueError, UnicodeError) as exc:
        raise SmokecheckError("Provider returned invalid JSON.") from exc
    if not isinstance(parsed, dict):
        raise SmokecheckError("Provider returned a non-object response.")
    return parsed


def _usage(obj):
    raw = obj.get("usage") or {}
    if not isinstance(raw, dict):
        return {}
    return {key: value for key, value in raw.items()
            if key in ("prompt_tokens", "completion_tokens", "total_tokens")
            and isinstance(value, int) and value >= 0}


def _normal_response(obj, mode):
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise SmokecheckError("Provider returned no valid choice.")
    message = choices[0].get("message") or {}
    if not isinstance(message, dict):
        raise SmokecheckError("Provider returned an invalid message.")
    if mode == "tool":
        tools = message.get("tool_calls")
        if not isinstance(tools, list) or not tools:
            raise SmokecheckError("Provider did not return a function call.")
        for call in tools:
            fn = call.get("function", {}) if isinstance(call, dict) else {}
            if fn.get("name") != "echo":
                continue
            try:
                arguments = json.loads(fn.get("arguments", ""))
            except (TypeError, ValueError):
                continue
            if isinstance(arguments, dict) and arguments.get("value") == "ping":
                return "tool_call_verified"
        raise SmokecheckError("Function call schema or arguments did not match the test.")
    content = message.get("content")
    if not isinstance(content, str) or content.strip().upper() != "PONG":
        raise SmokecheckError("Provider responded but did not satisfy the PONG test.")
    return "text_verified"


def _stream_response(response, started):
    chunks = []
    first_token_ms = None
    received_done = False
    usage = {}
    for raw_line in response:
        line = raw_line.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            received_done = True
            break
        event = _parse_json(data)
        usage.update(_usage(event))
        choices = event.get("choices")
        if not choices:
            continue
        first = choices[0]
        if not isinstance(first, dict):
            continue
        delta = first.get("delta") or {}
        if isinstance(delta, dict) and isinstance(delta.get("content"), str) and delta["content"]:
            chunks.append(delta["content"])
            if first_token_ms is None:
                first_token_ms = round((time.perf_counter() - started) * 1000, 1)
    if not received_done:
        raise SmokecheckError("Streaming response ended without [DONE].")
    if "".join(chunks).strip().upper() != "PONG":
        raise SmokecheckError("Streamed text did not satisfy the PONG test.")
    return first_token_ms, usage


def run(base_url, model, api_key, mode, timeout=30):
    url = completion_url(base_url)
    payload = make_payload(model, mode)
    body = json.dumps(payload).encode("utf-8")
    http_request = request.Request(
        url,
        data=body,
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if mode == "stream" else "application/json",
            "User-Agent": "FluxSimpleIA-Smokecheck/1.0",
        },
        method="POST",
    )
    opener = request.build_opener(NoRedirect())
    started = time.perf_counter()
    try:
        with opener.open(http_request, timeout=timeout) as response:
            if mode == "stream":
                first_token_ms, usage = _stream_response(response, started)
                kind = "stream_verified"
            else:
                obj = _parse_json(response.read().decode("utf-8", "replace"))
                kind = _normal_response(obj, mode)
                usage = _usage(obj)
                first_token_ms = None
    except error.HTTPError as exc:
        raise SmokecheckError(f"Provider returned HTTP {exc.code}; no secret or response body printed.") from exc
    except error.URLError as exc:
        raise SmokecheckError(f"Could not connect ({type(exc.reason).__name__}).") from exc
    except TimeoutError as exc:
        raise SmokecheckError("Provider timed out.") from exc
    result = {
        "success": True,
        "mode": mode,
        "result": kind,
        "model_requested": model,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        "time_to_first_content_ms": first_token_ms,
        "usage_reported": usage,
        "test_scope": "Single smokecheck; not reliability, quality, speed or billing proof.",
    }
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="OpenAI-compatible API base URL, usually ending /v1")
    parser.add_argument("--model", required=True, help="Model ID accepted by that provider")
    parser.add_argument("--mode", choices=("normal", "stream", "tool"), default="normal")
    parser.add_argument("--key-env", default="API_KEY", help="Name of environment variable containing the API key")
    parser.add_argument("--timeout", type=int, default=30, help="Request timeout in seconds (1-120)")
    args = parser.parse_args(argv)
    if args.timeout < 1 or args.timeout > 120:
        parser.error("--timeout must be between 1 and 120.")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", args.key_env):
        parser.error("--key-env must be a valid environment variable name.")
    api_key = os.environ.get(args.key_env)
    if not api_key:
        parser.error(f"Missing API key environment variable: {args.key_env}")
    try:
        result = run(args.base_url, args.model, api_key, args.mode, args.timeout)
    except SmokecheckError as exc:
        print(json.dumps({"success": False, "mode": args.mode, "error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
