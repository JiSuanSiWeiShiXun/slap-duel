# 新角色接入记录模板

从下面的 JSON 代码块复制完整内容到 `game/local/character-intake/<model-id>/intake.json`。该目录保持本地忽略；每次迭代使用新目录或 run-id，不覆盖旧验收证据。配套步骤与归因方法见[角色动画管线](animation-pipeline.md)。

先填写输入身份、工具、坐标和目标动作，再逐门补充证据。未知值用 `null`，未执行用 `PENDING`；发现明确失败记 `FAIL`，已执行但无法判断记 `UNKNOWN`，只有引用实际检查证据才能记 `PASS`。作者源、实际导入、固定播放和任意输入分别验收。`producerAdoption` 仅记录用户本人反馈及适用范围。

路径使用项目相对路径。不要粘贴密钥、服务账户、公开权限不明的原片地址或私人素材。新角色重新标定权重、骨轴与掌颊表面，不能套用旧模型顶点索引补丁。

```json
{
  "schemaVersion": 1,
  "purpose": "记录新模型接入与分层验收；模板不代表通过",
  "characterId": null,
  "runId": null,
  "createdAt": null,
  "parentRunId": null,
  "status": "PENDING",
  "scope": {
    "playerObservableResult": null,
    "taskId": null,
    "includedActions": [],
    "excludedOrUnverified": [],
    "testedDomain": null
  },
  "dependencies": {
    "authoringToolVersion": null,
    "engineVersion": null,
    "exporterVersion": null,
    "skinningMethod": null,
    "maxInfluencesPerVertex": null,
    "servicesUsed": [],
    "missingDependencies": [],
    "credentialsLocation": "本地环境变量；不在此记录凭据"
  },
  "sources": {
    "model": { "localPath": null, "sha256": null, "origin": null, "license": null, "redistributionAllowed": null },
    "motionReference": { "localPath": null, "sha256": null, "origin": null, "license": null, "redistributionAllowed": null },
    "rawMocap": { "localPath": null, "sha256": null, "serviceOrMethod": null, "parametersReceiptPath": null, "unmodified": null },
    "sourceActionSignature": null,
    "modelSignature": { "restPositions": null, "topology": null, "uv": null, "materials": null, "vertexOrder": null },
    "targetRigSignature": { "boneNamesAndParents": null, "restMatrices": null, "inverseBindMatrices": null, "weights": null }
  },
  "coordinateContract": {
    "sourceUnit": null,
    "targetUnit": null,
    "sourceUpAxis": null,
    "sourceForwardAxis": null,
    "targetUpAxis": null,
    "targetForwardAxis": null,
    "handedness": null,
    "rootScale": null,
    "restPoseEvidencePath": null,
    "boneAxisAndPivotEvidencePath": null
  },
  "retarget": {
    "sourceActionKind": null,
    "reuseMode": null,
    "compatibilityEvidencePath": null,
    "mappingTablePath": null,
    "sourceRestCalibrationPath": null,
    "targetRestCalibrationPath": null,
    "sourceReferencePoseEvidencePath": null,
    "targetReferencePoseEvidencePath": null,
    "targetBoneLengthPolicyPath": null,
    "profileVersion": null,
    "profileReuseContract": {
      "sourceRigSignature": null,
      "targetRigSignature": null,
      "calibrationSignature": null,
      "validForSourceRigVersions": [],
      "validForTargetRigVersions": [],
      "invalidationRulesPath": null,
      "perActionReviewEvidencePaths": []
    },
    "unmappedBones": [],
    "rootMotionPolicy": null,
    "scalePolicy": null,
    "elbowPoleDefinitionPath": null,
    "wristAndPalmAxesPath": null,
    "bakeAndTransferPolicyPath": null,
    "targetEditableActionPath": null,
    "manualCorrections": []
  },
  "characterProfile": {
    "semanticRigContractVersion": null,
    "boneClassificationPath": null,
    "chainMappingPolicyPath": null,
    "extraBonePolicyPath": null,
    "exportedDeformBonesPath": null,
    "runtimeSkeletonContractPath": null,
    "bodyProportionsPath": null,
    "boneMappingAndAxesPath": null,
    "skinSurfaceAnchorsPath": null,
    "elbowPoleDefinitionPath": null,
    "reachDomainPath": null,
    "boundedIkAdjustmentLimitsPath": null,
    "stanceAdjustmentLimitsPath": null,
    "sharedActionLibraryVersion": null,
    "specialVariants": [],
    "unsupportedPairings": []
  },
  "pairRegressionPlan": {
    "rosterVersion": null,
    "allowSameCharacterMatch": null,
    "directedPairCasesPath": null,
    "handednessAndStanceCasesPath": null,
    "actionAndInputCasesPath": null,
    "newCharacterDeltaCasesPath": null,
    "sharedLibraryChangeImpactPath": null
  },
  "pairContract": {
    "actorACharacterId": null,
    "actorBCharacterId": null,
    "actorARigSignature": null,
    "actorBRigSignature": null,
    "sharedClockDefinition": null,
    "worldScale": null,
    "stanceAndReachEvidencePath": null,
    "surfaceAnchorsPath": null,
    "surfaceSemantics": { "blockingSurface": null, "counterSurface": null, "targetCheek": null },
    "eventMarkers": [
      { "event": "incoming", "authorTimeSeconds": null, "ruleTimeMilliseconds": null },
      { "event": "block", "authorTimeSeconds": null, "ruleTimeMilliseconds": null },
      { "event": "counterContact", "authorTimeSeconds": null, "ruleTimeMilliseconds": null },
      { "event": "recovery", "authorTimeSeconds": null, "ruleTimeMilliseconds": null }
    ],
    "ruleContractPath": null,
    "fullPathCollisionSamplingPolicy": null
  },
  "acceptance": {
    "thresholdsDeclaredBeforeRunPath": null,
    "thresholdRationale": null,
    "standardPoses": { "status": "PENDING", "poseDefinitionsPath": null, "boneEvidencePath": null, "skinAndWireframeEvidencePath": null, "findings": [] },
    "modelAndBind": { "status": "PENDING", "reportPath": null, "reopenedSourceCheckPath": null, "findings": [] },
    "rawMocap": { "status": "PENDING", "videoAlignedSkeletonEvidencePath": null, "uncertainIntervals": [], "findings": [] },
    "retarget": { "status": "PENDING", "reportPath": null, "findings": [] },
    "pairContactAndMotion": { "status": "PENDING", "reportPath": null, "sampledTimesPath": null, "findings": [] },
    "realtimeVisualReview": { "status": "PENDING", "mainVideoPath": null, "oppositeVideoPath": null, "keyPosePaths": [], "playbackSpeed": null, "reviewer": null, "findings": [] },
    "exportAndActualImport": { "status": "PENDING", "savedSourceReferencePath": null, "exportReportPath": null, "actualImportReportPath": null, "findings": [] },
    "actualCocosPlayback": { "status": "PENDING", "buildId": null, "sourceDigest": null, "runtimeEvidencePath": null, "findings": [] },
    "arbitraryInputTransitions": { "status": "PENDING", "inputCasesPath": null, "ruleEventsAndHpEvidencePath": null, "transitionEvidencePath": null, "findings": [] },
    "devicePerformanceAndResume": { "status": "PENDING", "device": null, "evidencePath": null, "findings": [] },
    "producerAdoption": { "status": "PENDING", "feedbackVerbatim": null, "feedbackDate": null, "adoptedScope": null, "unadoptedOrUnverifiedScope": [] }
  },
  "controlledExperiments": [
    {
      "hypothesis": null,
      "firstBadLayer": null,
      "baselineRunId": null,
      "singleChangedFactor": null,
      "fixedInputsAndSignatures": [],
      "newVertexWeightInterpolationRule": null,
      "beforeEvidencePaths": [],
      "afterEvidencePaths": [],
      "result": "PENDING",
      "limitations": []
    }
  ],
  "manualChangeLog": [
    { "time": null, "author": null, "layer": null, "changedBonesOrRegion": null, "reason": null, "preservedInputs": [], "outputPath": null, "sha256": null, "costOrDurationEvidencePath": null }
  ],
  "artifacts": {
    "editableSourcePath": null,
    "editableSourceSha256": null,
    "deliveryManifestPath": null,
    "commandAndToolVersionsReceiptPath": null,
    "failedAttempts": [],
    "measuredCost": null,
    "measuredDuration": null
  },
  "conclusion": {
    "verifiedScope": [],
    "failedScope": [],
    "unknownOrUntestedScope": [],
    "nextAction": null,
    "qualityAdoption": "PENDING"
  }
}
```
