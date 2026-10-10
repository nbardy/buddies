# Claude thread failures: root-cause inspection — 2026-10-04

Owner requested debug-log inspection in #general, root post_01a105a9-6cce-7497-9858-2e6a91c9f1a3. No configuration, source, live store, or runtime mutation performed.

Affected thread: post_01a0e8a6-11b3-7046-ae87-5ae8e7bb48e8, font_maker workspace project_2f0a65f3-42a0-4527-92bf-686c29ed037a. Read through authenticated GET thread, conversation detail/diagnostics and error-journal APIs.

## Findings

1. Both Buddy profiles currently say provider codex, reasoning xhigh. The thread seats say Claude. The latest non-failure posts from Chief Scientist (2026-09-29T18:20:08.711Z) and Pixel Lead (2026-09-29T19:35:08.592Z) reference their Claude conversations. Pixel's earlier Codex posts reference 8299f9a9-13c5-5879-ad72-023746cd07af but precede those Claude replies. The observed next-seat projection is therefore consistent with latest thread reply > remembered choice > Buddy default. A bare mention is not an explicit provider override. The fetched posts do not preserve historical picker inputs; no claim is made about the owner's clicks.

2. Diagnostics show real new provider_error attempts across different server boot IDs; errors API gives weekly-limit failures for Chief Scientist and Pixel Lead's follow-up gate. This is not just an old failure notice or waiting for one reload.

3. Missing retry is a concrete classifier bug: isHarnessRetryFailure rejects the exact plain weekly-limit body. Executing the exported shared/dist function returned false. shared/src/harness-retry.ts handles out_of_tokens, gate failures, unavailable-model and specific provider-error envelopes, but omits this provider's plain weekly-limit wording. ReplyRetry returns null on false. Gate-wrapped versions match a separate branch and can show a button.

4. Chief's desired config resolves Sonnet, while latest observedModel says Opus. This discrepancy warrants separate provider resume/model investigation; it does not change the cause of selecting the Claude provider or the missing retry classifier.

## Preserved API evidence

Thread seats:

```json
[
  {
    "buddyId": "buddy_b2ff0a7e-591c-4e76-9cc1-0cda8d171ec3",
    "config": {
      "provider": "claude",
      "model": {
        "mode": "explicit",
        "modelId": "claude-sonnet-5-5"
      },
      "reasoning": {
        "mode": "default"
      }
    }
  },
  {
    "buddyId": "buddy_f4940aaa-059d-4105-aa0c-0eb1fd4de3b5",
    "config": {
      "provider": "claude",
      "model": {
        "mode": "default"
      },
      "reasoning": {
        "mode": "default"
      }
    }
  }
]
```

Conversation diagnostics:

```json
[
  {
    "id": "3b08185a-4e32-5931-91f8-68d8cae20a8d",
    "config": {
      "config": {
        "provider": "claude",
        "model": {
          "mode": "explicit",
          "modelId": "claude-sonnet-5-5"
        },
        "reasoning": {
          "mode": "default"
        }
      },
      "revision": 1,
      "resolution": {
        "status": "resolved",
        "catalogRevision": "e72590109dcdd99f",
        "value": {
          "provider": "claude",
          "modelId": "claude-sonnet-5-5",
          "reasoningEffort": "medium"
        }
      }
    },
    "observedModel": "claude-opus-5-5",
    "attempts": [
      {
        "id": "c1c8da7f-6130-4970-a5b6-113c628f72ca",
        "boot": "c4fae323-ce42-4d2e-bd06-9e2d89067c46",
        "at": "2026-10-04T07:39:26.916Z",
        "state": "failed",
        "cause": "provider_error"
      },
      {
        "id": "f5cc48da-1372-40c3-957e-c246b1db12d7",
        "boot": "806d746d-b685-4b65-88b4-ac3ad23a44cb",
        "at": "2026-10-04T06:52:02.120Z",
        "state": "failed",
        "cause": "provider_error"
      },
      {
        "id": "9b2e20bd-6463-41eb-9559-ab356d350816",
        "boot": "806d746d-b685-4b65-88b4-ac3ad23a44cb",
        "at": "2026-10-04T06:44:57.507Z",
        "state": "failed",
        "cause": "provider_error"
      }
    ]
  },
  {
    "id": "35359d68-dee2-50fd-8b49-75ecfcafa34f",
    "config": {
      "config": {
        "provider": "claude",
        "model": {
          "mode": "default"
        },
        "reasoning": {
          "mode": "default"
        }
      },
      "revision": 0,
      "resolution": {
        "status": "resolved",
        "catalogRevision": "e72590109dcdd99f",
        "value": {
          "provider": "claude",
          "modelId": "claude-opus-5-5",
          "reasoningEffort": "medium"
        }
      }
    },
    "observedModel": "claude-opus-5-5",
    "attempts": [
      {
        "id": "4f186746-0eb0-4180-9a84-ca081ea308f7",
        "boot": "806d746d-b685-4b65-88b4-ac3ad23a44cb",
        "at": "2026-10-04T06:52:02.105Z",
        "state": "failed",
        "cause": "provider_error"
      },
      {
        "id": "196c5b40-f898-4dc1-97ad-0bda0eb22f1b",
        "boot": "806d746d-b685-4b65-88b4-ac3ad23a44cb",
        "at": "2026-10-04T06:44:57.500Z",
        "state": "failed",
        "cause": "provider_error"
      },
      {
        "id": "5fac1614-3dcf-4471-9694-c947edc3da61",
        "boot": "bffa402c-d0b5-4891-88a5-1855d8e267c0",
        "at": "2026-10-04T06:38:16.687Z",
        "state": "failed",
        "cause": "provider_error"
      }
    ]
  }
]
```

Relevant error groups:

```json
[
  {
    "fingerprint": "691ae65265e594fbf8d56235",
    "message": "[channels] reply gate failed for buddy_f4940aaa-059d-4105-aa0c-0eb1fd4de3b5 on post post_01a105da-7b29-7284-9b82-4c9f2800f75f: gate run ended: error (You've hit your weekly limit · resets 7pm (Asia/Makassar))",
    "lastSeenAt": "2026-10-04T07:39:29.712Z",
    "count": 38
  },
  {
    "fingerprint": "681502ec16cc2c6db98ab33d",
    "message": "[3b08185a-4e32-5931-91f8-68d8cae20a8d] Provider error: You've hit your weekly limit · resets 7pm (Asia/Makassar)",
    "lastSeenAt": "2026-10-04T07:39:29.593Z",
    "count": 16
  }
]
```

## Follow-through

Owner Task task_01a105b0-2c7c-7527-bff6-aa092ec61da0 remains open. Correct acceptance: reproduce plain weekly-limit classifier failure and repair existing retry contract, then verify rendered retry on this exact envelope. Avoid changing thread priority silently: it follows the requested thread-continuity rule. Immediate existing control: explicitly select Codex/gpt-6.1-sol on each Buddy mention; subsequent successful replies should retain that choice. No such live action was performed in this inspection.
