import { type Request, type Response } from "express";

import { env } from "@/config/env.js";
import { canvasCacheService } from "@/services/canvas-cache.service.js";
import { dbService, type AiMessage } from "@/services/db.service.js";
import { openAiService, type TAiOperation } from "@/services/openai.service.js";
import { toElementDto } from "@/socket/canvas.handlers.js";
import { tryGetIo } from "@/socket/index.js";
import { projectRoom, type TAiMessageDto } from "@/socket/socket.types.js";

import type { ProjectIdParams } from "@/modules/project/project.validation.js";

import type { SendAiMessageBody } from "./ai.validation.js";

/** How many prior turns are sent back to the model as conversational context. */
const AI_HISTORY_LIMIT = 20;

const FALLBACK_REPLY = "Sorry, I couldn't process that request. Please try again in a moment.";

const toAiMessageDto = (message: AiMessage): TAiMessageDto => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
});

const broadcastAiMessage = (projectId: string, message: TAiMessageDto): void => {
  tryGetIo()
    ?.to(projectRoom(projectId))
    .emit("ai:messageCreated", { projectId, socketId: "", message });
};

export const listAiMessages = async (req: Request<ProjectIdParams>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const membership = await dbService.getProjectForUser(projectId, requesterId);

  if (!membership) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const messages = await dbService.listAiMessages(projectId);

  res.status(200).json({ messages: messages.map(toAiMessageDto) });
};

/**
 * Applies the AI's proposed operations through the canvas cache — the same
 * path a human edit takes — so version bookkeeping and the eventual DB flush
 * stay consistent. AI-minted `elementId`s are re-keyed to real UUIDs as
 * they're created, so a later "update"/"delete" op in the same batch that
 * refers to an id the AI just invented still resolves correctly.
 */
const applyOperations = async (
  projectId: string,
  canvasId: string,
  operations: TAiOperation[],
): Promise<{ created: number; updated: number; deleted: number; skipped: number }> => {
  const idMap = new Map<string, string>();
  const resolveId = (id: string): string => idMap.get(id) ?? id;

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;

  for (const op of operations) {
    if (op.action === "create") {
      const count = await canvasCacheService.countElements(projectId, canvasId);

      if (count >= env.MAX_ELEMENTS_PER_CANVAS) {
        skipped += 1;
        continue;
      }

      const elementId = crypto.randomUUID();
      idMap.set(op.elementId, elementId);

      const element = await canvasCacheService.createElement(
        projectId,
        canvasId,
        {
          elementId,
          type: op.type,
          x: op.x,
          y: op.y,
          width: op.width,
          height: op.height,
          rotation: op.rotation,
          opacity: op.opacity,
          fill: op.fill,
          stroke: op.stroke,
          strokeWidth: op.strokeWidth,
          cornerRadius: op.cornerRadius,
          props: op.props,
        },
        // No user authored this element — AI-created.
        null,
      );

      if (element) {
        created += 1;
        tryGetIo()
          ?.to(projectRoom(projectId))
          .emit("element:created", { projectId, canvasId, socketId: "", element: toElementDto(element) });
      } else {
        skipped += 1;
      }

      continue;
    }

    if (op.action === "update") {
      const elementId = resolveId(op.elementId);
      const current = (await canvasCacheService.listElements(projectId, canvasId)).find(
        (element) => element.elementId === elementId,
      );

      if (!current) {
        skipped += 1;
        continue;
      }

      const outcome = await canvasCacheService.applyPatch(projectId, canvasId, elementId, current.version, op.patch);

      if (outcome.status === "applied") {
        updated += 1;
        tryGetIo()
          ?.to(projectRoom(projectId))
          .emit("element:updated", {
            projectId,
            canvasId,
            socketId: "",
            elementId,
            version: outcome.version,
            patch: op.patch,
          });
      } else {
        skipped += 1;
      }

      continue;
    }

    // op.action === "delete"
    const elementId = resolveId(op.elementId);
    const removed = await canvasCacheService.deleteElements(projectId, canvasId, [elementId]);

    if (removed.length > 0) {
      deleted += 1;
      tryGetIo()
        ?.to(projectRoom(projectId))
        .emit("element:deleted", { projectId, canvasId, socketId: "", elementIds: removed });
    } else {
      skipped += 1;
    }
  }

  return { created, updated, deleted, skipped };
};

const summarizeOps = (counts: { created: number; updated: number; deleted: number; skipped: number }): string | null => {
  const parts: string[] = [];

  if (counts.created > 0) parts.push(`created ${counts.created}`);
  if (counts.updated > 0) parts.push(`updated ${counts.updated}`);
  if (counts.deleted > 0) parts.push(`deleted ${counts.deleted}`);
  if (counts.skipped > 0) parts.push(`skipped ${counts.skipped} (changed since last view)`);

  if (parts.length === 0) {
    return null;
  }

  return `${parts.join(", ")}.`;
};

export const sendAiMessage = async (req: Request<ProjectIdParams, unknown, SendAiMessageBody>, res: Response) => {
  const { projectId } = req.params;
  const requesterId = req.user!.userId;

  const membership = await dbService.getProjectForUser(projectId, requesterId);

  if (!membership) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (membership.member.role === "viewer") {
    res.status(403).json({ error: "Viewers cannot use the AI assistant" });
    return;
  }

  const { canvasId, content } = req.body;

  const canvas = await canvasCacheService.getCanvas(projectId, canvasId);

  if (!canvas) {
    res.status(404).json({ error: "Slide not found" });
    return;
  }

  const userMessage = await dbService.createAiMessage({
    projectId,
    canvasId,
    role: "user",
    content,
    createdBy: requesterId,
  });
  const userMessageDto = toAiMessageDto(userMessage);
  broadcastAiMessage(projectId, userMessageDto);

  const [elements, historyRows] = await Promise.all([
    canvasCacheService.listElements(projectId, canvasId),
    dbService.listAiMessages(projectId, canvasId, { limit: AI_HISTORY_LIMIT }),
  ]);

  let reply: string;
  let opsSummary: string | null = null;

  try {
    const aiResponse = await openAiService.generateLayoutResponse({
      userPrompt: content,
      canvas: { width: canvas.width, height: canvas.height, backgroundColor: canvas.backgroundColor },
      elements,
      history: historyRows.map((row) => ({ role: row.role, content: row.content })),
    });

    reply = aiResponse.reply;

    if (aiResponse.operations.length > 0) {
      const counts = await applyOperations(projectId, canvasId, aiResponse.operations);
      opsSummary = summarizeOps(counts);
    }
  } catch (error) {
    console.error("AI assistant request failed", error);
    reply = FALLBACK_REPLY;
  }

  const assistantMessage = await dbService.createAiMessage({
    projectId,
    canvasId,
    role: "assistant",
    content: reply,
    opsSummary,
    createdBy: null,
  });
  const assistantMessageDto = toAiMessageDto(assistantMessage);
  broadcastAiMessage(projectId, assistantMessageDto);

  res.status(201).json({ userMessage: userMessageDto, assistantMessage: assistantMessageDto });
};
