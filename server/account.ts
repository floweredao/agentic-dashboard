import { z } from "zod";
import { AccountFeaturesSchema, AccountSchema, type AccountPreferences } from "../shared/account";
import type { Store } from "./store";
import { ApiError } from "./errors";
import { eraseTenant } from "./tenant-data";
import type { AudioStore } from "./audio-store";
import { accountExport } from "./account-export";

const userRow = z.object({ id: z.string(), email: z.email().nullable(), locale: z.enum(["system", "en", "ko"]).nullable(),
  time_zone: z.string().nullable(), onboarded_at: z.string().nullable(), agent_saved_at: z.string().nullable(),
  features: z.string(), agent_saved_record: z.string().nullable() });
const exportReadme = [
  "floweredao account export / 계정 내보내기", "",
  "Open this .tar.gz archive with your operating system's archive utility.",
  "data.json contains your account and every tenant table: records, HTML documents, trash, comments, digests, narration scripts, agents, shares, settings and push endpoints.",
  "Record data and digest sections are JSON strings inside their table rows. audio/ contains audio referenced by narration rows.",
  "Credentials, session secrets, invitation hashes and encryption keys are excluded. Treat the remaining content and push endpoints as private.",
  "This is a portable data export, not a server backup. There is no user-facing bulk import/restore. The operator restore tool accepts its separate encrypted-credential-bearing NDJSON backup only.",
  "", "운영체제의 압축 해제 도구로 열어 주세요. data.json에는 계정과 모든 계정별 테이블이 있고, audio/에는 저장된 낭독 음성이 있어요.",
  "기록의 data와 다이제스트 sections 값은 JSON 문자열이에요. 비밀번호·인증 토큰·세션 비밀값은 제외했지만, 내용과 푸시 주소는 비공개로 보관해 주세요.",
  "사용자용 일괄 가져오기·복원 기능은 제공하지 않아요. 운영자 백업 복원과 다른 형식이에요.",
].join("\n");

export function createAccount(store: Store, defaults: { readonly timeZone: string; readonly audio: AudioStore }) {
  const userId = store.db.userId;
  async function profile(sql = store.db.sql) {
    const raw = await sql.get("SELECT id,email,locale,time_zone,onboarded_at,agent_saved_at,agent_saved_record,features FROM users WHERE id=? AND deleted_at IS NULL", [userId]);
    if (!raw) throw new ApiError(401, "unauthenticated", "Account is no longer active");
    const user = userRow.parse(raw);
    return AccountSchema.parse({ id: user.id, email: user.email, locale: user.locale ?? "system",
      timeZone: user.time_zone ?? defaults.timeZone, onboardedAt: user.onboarded_at, agentSaveVerified: user.agent_saved_at !== null,
      agentSaveRecordId: user.agent_saved_record,
      features: AccountFeaturesSchema.parse(JSON.parse(user.features)) });
  }
  return {
    profile,
    async preferences(input: AccountPreferences) {
      const current = await profile();
      await store.db.sql.run("UPDATE users SET locale=?,time_zone=?,features=? WHERE id=? AND deleted_at IS NULL",
        [input.locale ?? current.locale, input.timeZone ?? current.timeZone, JSON.stringify(input.features ?? current.features), userId]);
      return { ...current, ...input };
    },
    async verifiedSave(recordId: string) {
      await store.db.sql.run("UPDATE users SET agent_saved_at=COALESCE(agent_saved_at,?),agent_saved_record=? WHERE id=? AND deleted_at IS NULL",
        [new Date(store.now()).toISOString(), recordId, userId]);
    },
    async complete() {
      const account = await profile();
      if (!account.agentSaveVerified) throw new ApiError(409, "agent_save_required", "Save one record from your connected agent before finishing setup");
      const onboardedAt = account.onboardedAt ?? new Date(store.now()).toISOString();
      await store.db.sql.run("UPDATE users SET onboarded_at=? WHERE id=? AND deleted_at IS NULL", [onboardedAt, userId]);
      return { ...account, onboardedAt };
    },
    export(signal?: AbortSignal) { return accountExport(store, defaults.audio, exportReadme, signal); },
    async remove(confirm: string, authenticatedAt: number) {
      await store.db.sql.tx(async sql => {
        const account = await profile(sql);
        if (userId === "local" || !account.email) throw new ApiError(404, "account_deletion_unavailable", "Use the self-host administrator to remove local data");
        if (confirm !== account.email) throw new ApiError(400, "confirmation_mismatch", "Type your account email exactly");
        if (authenticatedAt <= store.now() - 600000 || authenticatedAt > store.now()) throw new ApiError(403, "reauth_required", "Sign in again to confirm account deletion");
        await eraseTenant(sql, userId);
        await sql.run(`UPDATE users SET email=NULL,name=NULL,locale=NULL,time_zone=NULL,features='{"digest":false,"push":false}',
          gemini_key_ct=NULL,gemini_key_kek=NULL,onboarded_at=NULL,agent_saved_at=NULL,agent_saved_record=NULL,last_seen_at=NULL,
          export_lease=NULL,export_until=NULL,deleted_at=? WHERE id=?`,
        [new Date(store.now()).toISOString(), userId]);
      });
      try { await defaults.audio.removeAll(userId); }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        // Active data and credentials are already gone. Maintenance retries the tombstone's private prefix.
        console.error("account audio cleanup deferred", { failure: error.name });
      }
    },
  };
}
