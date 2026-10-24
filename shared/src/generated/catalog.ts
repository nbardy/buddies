// DO NOT EDIT - generated from catalog.jsonc
// Source: vendor/agent-cli-tool/catalog.jsonc (revision 2026-10-08.haiku-5.5)
// Generator: shared/scripts/gen-catalog.ts
// Run: pnpm --filter @unleashd/shared gen:catalog

import type { CatalogProvider } from '../provider-catalog.js';

export const PROVIDER_MODEL_CATALOG: readonly CatalogProvider[] = [
  {
    "id": "claude",
    "displayName": "Claude",
    "shortName": "C",
    "models": [
      {
        "id": "fable",
        "displayName": "Fable 5.1",
        "reasoning": {
          "levels": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "claude-opus-5-5",
        "displayName": "Opus 5.5",
        "reasoning": {
          "levels": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "claude-sonnet-5-5",
        "displayName": "Sonnet 5.5",
        "reasoning": {
          "levels": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "claude-haiku-5-5",
        "displayName": "Haiku 5.5",
        "reasoning": {
          "levels": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ],
          "defaultEffort": "medium"
        }
      }
    ],
    "defaultModelId": "claude-opus-5-5",
    "supportsDynamicModels": false,
    "aliases": {
      "sonnet": "claude-sonnet-5-5"
    }
  },
  {
    "id": "codex",
    "displayName": "Codex",
    "shortName": "X",
    "models": [
      {
        "id": "gpt-5.6-sol",
        "displayName": "GPT-5.6 Sol",
        "reasoning": {
          "levels": [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-5.6-terra",
        "displayName": "GPT-5.6 Terra",
        "reasoning": {
          "levels": [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-5.6-luna",
        "displayName": "GPT-5.6 Luna",
        "reasoning": {
          "levels": [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-5.5",
        "displayName": "GPT-5.5",
        "reasoning": {
          "levels": [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-5.4",
        "displayName": "GPT-5.4",
        "reasoning": {
          "levels": [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-5.4-mini",
        "displayName": "GPT-5.4 Mini",
        "reasoning": {
          "levels": [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-6-astra",
        "displayName": "GPT-6 Astra",
        "reasoning": {
          "levels": [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-6.1-sol",
        "displayName": "GPT-6.1 Sol",
        "reasoning": {
          "levels": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-6-sol",
        "displayName": "GPT-6 Sol",
        "reasoning": {
          "levels": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-6-luna",
        "displayName": "GPT-6 Luna",
        "reasoning": {
          "levels": [
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "gpt-5.3-codex-spark",
        "displayName": "Codex Spark",
        "reasoning": {
          "levels": [
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      }
    ],
    "defaultModelId": "gpt-6.1-sol",
    "supportsDynamicModels": false,
    "aliases": {}
  },
  {
    "id": "opencode",
    "displayName": "OpenCode",
    "shortName": "O",
    "models": [
      {
        "id": "opencode/big-pickle",
        "displayName": "OpenCode Big Pickle (Free)"
      },
      {
        "id": "opencode/gpt-5-nano",
        "displayName": "OpenCode GPT-5 Nano (Free)"
      },
      {
        "id": "opencode/kimi-k2.5-free",
        "displayName": "OpenCode Kimi K2.5 Free"
      },
      {
        "id": "opencode/minimax-m2.5-free",
        "displayName": "OpenCode MiniMax M2.5 Free"
      },
      {
        "id": "meta/muse-spark-1.1",
        "displayName": "Muse Spark 1.1 (Meta)"
      },
      {
        "id": "meta/muse-spark-1.2-contributor",
        "displayName": "Muse Spark 1.2 Contributor (Meta)"
      },
      {
        "id": "meta/muse-spark-1.3",
        "displayName": "Muse Spark 1.3 (Meta)"
      },
      {
        "id": "meta/muse-spark-1.3-contributor",
        "displayName": "Muse Spark 1.3 Contributor (Meta)"
      }
    ],
    "defaultModelId": "opencode/big-pickle",
    "supportsDynamicModels": true,
    "aliases": {}
  },
  {
    "id": "gemini",
    "displayName": "Gemini",
    "shortName": "G",
    "models": [
      {
        "id": "gemini-3.1-pro-preview",
        "displayName": "Gemini 3.1 Pro Preview"
      },
      {
        "id": "gemini-2.5-pro",
        "displayName": "Gemini 2.5 Pro"
      },
      {
        "id": "gemini-2.5-flash",
        "displayName": "Gemini 2.5 Flash"
      },
      {
        "id": "gemini-2.0-flash",
        "displayName": "Gemini 2.0 Flash"
      }
    ],
    "defaultModelId": "gemini-2.5-pro",
    "supportsDynamicModels": false,
    "aliases": {}
  },
  {
    "id": "cursor",
    "displayName": "Cursor",
    "shortName": "Cu",
    "models": [
      {
        "id": "composer-2.5",
        "displayName": "Composer 2.5"
      },
      {
        "id": "grok-4.7-xhigh",
        "displayName": "Grok 4.7 Extra High"
      },
      {
        "id": "grok-4.7-high",
        "displayName": "Grok 4.7 High"
      },
      {
        "id": "grok-4.7-medium",
        "displayName": "Grok 4.7 Medium"
      },
      {
        "id": "grok-4.7-low",
        "displayName": "Grok 4.7 Low"
      },
      {
        "id": "cursor-grok-4.5-high",
        "displayName": "Grok 4.5 High"
      },
      {
        "id": "cursor-grok-4.5-medium",
        "displayName": "Grok 4.5 Medium"
      },
      {
        "id": "cursor-grok-4.5-low",
        "displayName": "Grok 4.5 Low"
      }
    ],
    "defaultModelId": "composer-2.5",
    "supportsDynamicModels": false,
    "aliases": {
      "composer-2": "composer-2.5",
      "composer2": "composer-2.5",
      "composer-2-fast": "composer-2.5",
      "composer-2.5-fast": "composer-2.5",
      "grok-4.5": "cursor-grok-4.5-high",
      "grok-4.7": "grok-4.7-high"
    }
  },
  {
    "id": "muse",
    "displayName": "Muse",
    "shortName": "M",
    "models": [
      {
        "id": "muse-spark-1.1",
        "displayName": "Muse Spark 1.1",
        "reasoning": {
          "levels": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "muse-spark-1.2-contributor",
        "displayName": "Muse Spark 1.2 Contributor",
        "reasoning": {
          "levels": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "muse-spark-1.3",
        "displayName": "Muse Spark 1.3",
        "reasoning": {
          "levels": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      },
      {
        "id": "muse-spark-1.3-contributor",
        "displayName": "Muse Spark 1.3 Contributor",
        "reasoning": {
          "levels": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "ultra"
          ],
          "defaultEffort": "medium"
        }
      }
    ],
    "defaultModelId": "muse-spark-1.3-contributor",
    "supportsDynamicModels": false,
    "aliases": {}
  }
];
