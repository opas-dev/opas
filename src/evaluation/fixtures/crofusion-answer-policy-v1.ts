// ABOUTME: Freezes production retrieval boundaries for the CROFusion answer policy.
// ABOUTME: Binds measured scores to the exact active corpus and embedding configuration.

type RetrievalBoundary = readonly [
  id: string,
  strongestScore: number,
  competingArticleGap: number,
];

export const crofusionAnswerPolicyCalibrationV1 = Object.freeze({
  schema: "opas.answer-policy-calibration.v1",
  id: "crofusion_answer_policy_v1",
  capturedAt: "2026-09-01T00:00:00.000Z",
  provenance: "launch-partner-production" as const,
  workspaceId: "workspace_demo",
  sourceContentHash:
    "dcc95593262ca7e1ef67686210e58be180e38d68d8b0ee6967f85f643c8d235b",
  indexGeneration: 2,
  embeddingGenerationId:
    "embedding_generation_9c6a464d-ef0f-4e54-94cf-7f71fe8c1f8a",
  embeddingProvider: "cloudflare-workers-ai",
  embeddingModel: "@cf/baai/bge-base-en-v1.5",
  embeddingConfigurationHash:
    "d3615bfed4585769e91a15ea9a362c08ee8c74c118d512249d9231b5caf24df0",
  answerable: Object.freeze([
    ["crofusion_answerable_01", 1, 0.2540385525542962],
    ["crofusion_answerable_02", 1, 0.2545599533957458],
    ["crofusion_answerable_03", 0.6827714903525504, 0.08867905819115995],
    ["crofusion_answerable_04", 0.8333333333333334, 0.11675465443689503],
    ["crofusion_answerable_05", 0.7710808101233461, 0.06814400318691505],
    ["crofusion_answerable_06", 0.5877803360052762, 0.015163622221115558],
    ["crofusion_answerable_07", 0.663009596246765, 0.05839820453310862],
    ["crofusion_answerable_08", 0.807134362139642, 0.20533990111717415],
    ["crofusion_answerable_09", 0.7279527916604069, 0.11470984574164478],
    ["crofusion_answerable_10", 0.8333333333333334, 0.16623029289725433],
    ["crofusion_answerable_11", 0.726049, 0.004118],
    ["crofusion_answerable_12", 0.8062921324539228, 0.10190505520025572],
    ["crofusion_answerable_13", 0.8, 0.09887450559309952],
    ["crofusion_answerable_14", 0.7795260025228605, 0.02737492860352375],
    ["crofusion_answerable_15", 0.8333333333333334, 0.08934399714577834],
    ["crofusion_answerable_16", 0.7004630103281412, 0.019231309408812125],
    ["crofusion_answerable_17", 0.7910500727030872, 0.14769272551586954],
    ["crofusion_answerable_18", 0.6998261995911252, 0.0922373176458291],
    ["crofusion_answerable_19", 0.7142857142857143, 0.1079528286220619],
    ["crofusion_answerable_20", 0.6107482517417034, 0.025571481708895116],
  ] as const satisfies readonly RetrievalBoundary[]),
  unsupported: Object.freeze([
    ["crofusion_unsupported_01", 0.7538107319495362, 0.030054809573524355],
    ["crofusion_unsupported_02", 0.6776527879379446, 0.0671883279664357],
    ["crofusion_unsupported_03", 0.5115201432650557, 0.02398042405150974],
    ["crofusion_unsupported_04", 0.4952559986224649, 0.01241503205857486],
    ["crofusion_unsupported_05", 0.5141167436624923, 0.006497914844411756],
    ["crofusion_unsupported_06", 0.5659087364535557, 0.06272683981913774],
    ["crofusion_unsupported_07", 0.5138069028695421, 0.010212022534576426],
    ["crofusion_unsupported_08", 0.6461212241727547, 0.01495863250158469],
    ["crofusion_unsupported_09", 0.7388576960434432, 0.020457272156232276],
    ["crofusion_unsupported_10", 0.5564018344335828, 0.009160593098108794],
  ] as const satisfies readonly RetrievalBoundary[]),
  conflictCanaries: Object.freeze([
    ["crofusion_conflicting_01", 0.7812857850899881, 0.00673885965448362],
    ["crofusion_conflicting_02", 0.8055065694372646, 0.00603398226181906],
  ] as const satisfies readonly RetrievalBoundary[]),
});
