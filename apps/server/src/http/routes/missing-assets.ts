import type { FastifyInstance } from "fastify";
import { AppError } from "../../../../../packages/core/src/contracts";
import type { Repo } from "../../db/repo";
import { relocateMissingAsset, relocationCandidates, removeMissingAsset } from "../../services/missing-assets";
import { fail } from "../routes";

const invalid = (field: string) => new AppError("INVALID_INPUT", field + " 格式不正确。", 400);

function assetId(id: string) {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw invalid("文件编号");
  return Number(id);
}

function numberField(body: Record<string, unknown> | undefined, key: string) {
  const value = body?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalid(key);
  return value;
}

function pathField(body: Record<string, unknown> | undefined, key: string) {
  const value = body?.[key];
  if (typeof value !== "string" || !value.trim()) throw invalid(key);
  return value;
}

type Request = { Params: { id: string }; Body: Record<string, unknown> };
function sourceSelection(body: Request["Body"]) {
  return { expectedPath: pathField(body, "expectedPath"), expectedItemId: numberField(body, "expectedItemId") };
}

export function registerMissingAssetRoutes(app: FastifyInstance, repo: Repo) {
  app.get<Request>("/api/assets/:id/relocation-candidates", async (req, reply) => {
    try { return relocationCandidates(repo, assetId(req.params.id)); }
    catch (err) { return fail(reply, err); }
  });
  app.post<Request>("/api/assets/:id/remove-missing", async (req, reply) => {
    try { return await removeMissingAsset(repo, assetId(req.params.id), sourceSelection(req.body)); }
    catch (err) { return fail(reply, err); }
  });
  app.post<Request>("/api/assets/:id/relocate", async (req, reply) => {
    const abort = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.once("close", onClose);
    try {
      return await relocateMissingAsset(repo, assetId(req.params.id), {
        ...sourceSelection(req.body), candidateId: numberField(req.body, "candidateId"),
        expectedCandidatePath: pathField(req.body, "expectedCandidatePath"),
        expectedCandidateItemId: numberField(req.body, "expectedCandidateItemId"),
      }, abort.signal);
    } catch (err) { return fail(reply, err); }
    finally { reply.raw.off("close", onClose); }
  });
}
