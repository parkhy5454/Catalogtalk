// [수정] Sentry 초기화를 별도 파일(instrument.ts)로 분리해서, 반드시 이 파일의 맨 첫
// import로 둔다. 아래에서 express 등을 import하기 "전에" Sentry.init()이 실제로 다
// 끝나도록 하기 위함 (같은 파일 안에서 순서만 바꾸는 건 esbuild의 import 호이스팅 때문에
// 소용없었다 — 자세한 이유는 instrument.ts 상단 주석 참고).
import { Sentry, SENTRY_DSN } from './instrument.js';
import { getErrorMessage, getErrorField } from './src/errorUtils.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import vision from '@google-cloud/vision';
import * as XLSX from 'xlsx';
import archiver from 'archiver';

// ------------------------------------------------------------------
// 🚨 자동 에러 모니터링(Sentry) — 초기화 자체는 instrument.ts에서 이미 끝났고,
// 여기서는 기존 console.error 호출을 Sentry로도 함께 보고되게 감싸는 부분만 남는다.
// ------------------------------------------------------------------

// [수정] 코드 곳곳(수백 곳)에 이미 있는 console.error(...) 호출을 하나하나 다 안 고쳐도,
// console.error 자체를 감싸서 "화면(로그)에 찍히는 동시에 Sentry에도 자동으로 보고"되게 만든다.
// 이렇게 하면 오늘까지 쌓인 기존 에러 처리 코드가 전부 자동으로 모니터링 대상이 된다.
const __originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  __originalConsoleError(...args);
  if (!SENTRY_DSN) return;
  try {
    const errorArg = args.find((a) => a instanceof Error);
    if (errorArg) {
      Sentry.captureException(errorArg, { extra: { logArgs: args.filter((a) => a !== errorArg).map(String) } });
    } else {
      Sentry.captureMessage(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '), 'error');
    }
  } catch {
    // Sentry 보고 자체가 실패해도 서버 동작에는 절대 영향을 주면 안 된다
  }
};

// 어디서도 안 잡힌 예외/프로미스 거부까지 마지막 안전망으로 잡아서 보고
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 처리되지 않은 예외:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] 처리되지 않은 프로미스 거부:', reason);
});

// [수정] Gemini API가 "This model is currently experiencing high demand"(503/UNAVAILABLE) 같은
// 일시적인 과부하 에러를 낼 때가 있다. 이런 경우 사용자에게 바로 에러를 보여주지 않고,
// 짧게 대기했다가 자동으로 한두 번 더 시도해서 대부분의 일시적 실패를 자동으로 넘어가게 한다.
//
// [추가] 실제 운영 로그를 보면 재시도 2번(800ms, 1600ms) 동안에도 같은 모델(gemini-3.5-flash)이
// 계속 503으로 응답하는 경우가 있었다 — 그 모델 자체가 그 순간 전체적으로 몰려있는 상황이라,
// "같은 모델에 더 기다렸다 다시 요청"하는 것만으로는 한계가 있다. 그래서 마지막(재시도를 다
// 소진한) 시점에 한해서, 딱 한 번 다른 모델(FALLBACK_MODEL)로 넘겨서 시도해본다. 별도의 모델
// 풀(pool)이라 원래 모델이 과부하여도 정상 응답할 가능성이 있고, 이미 폴백 모델로 시도한
// 요청이면(무한 폴백 방지) 더 이상 폴백하지 않는다.
const PRIMARY_GEMINI_MODEL = 'gemini-3.5-flash';
const FALLBACK_GEMINI_MODEL = 'gemini-2.5-flash';

type GenerateParams = Parameters<GoogleGenAI['models']['generateContent']>[0];
type GenerateResult = Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;

async function generateContentWithRetry(
  ai: GoogleGenAI,
  params: GenerateParams,
  maxRetries: number = 2
): Promise<GenerateResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: unknown) {
      lastErr = err;
      const message = getErrorMessage(err);
      // [수정] "RESOURCE_EXHAUSTED"(429, 할당량 완전 소진)를 "UNAVAILABLE"(503, 일시적
      // 서버 과부하)과 같은 걸로 취급해서 재시도하고 있었다. 하지만 할당량 소진은 몇 초
      // 기다린다고 풀리는 게 아니라서, 재시도해봐야 100% 또 실패하고 시간과 호출 횟수만
      // 낭비된다(실제로 매일 자동배치가 회사 하나당 쓸데없이 2번씩 더 재시도하며 시간을
      // 끄는 문제가 있었다). 할당량 소진은 재시도 없이 바로 실패시켜서 빠르게 포기하고,
      // 일시적 과부하(503)만 재시도한다. (참고: 할당량은 모델별이 아니라 API 키 단위로
      // 걸리는 경우가 많아서, 폴백 모델로 바꿔도 어차피 똑같이 막힐 가능성이 높다 — 그래서
      // 할당량 소진은 폴백 대상에서도 제외한다.)
      const isQuotaExhausted = getErrorField(err, 'status') === 429 || getErrorField(err, 'code') === 429 || /RESOURCE_EXHAUSTED/i.test(message);
      if (isQuotaExhausted) throw err;
      const isTransient = getErrorField(err, 'status') === 503 || getErrorField(err, 'code') === 503 ||
        /UNAVAILABLE|high demand|overloaded/i.test(message);
      if (!isTransient) throw err;
      if (attempt === maxRetries) {
        // 재시도를 다 썼는데도 여전히 과부하 → 마지막으로 딱 한 번, 다른 모델로 시도해본다.
        if (params?.model && params.model !== FALLBACK_GEMINI_MODEL) {
          console.warn(`[Gemini] ${params.model} 반복 과부하로 폴백 모델(${FALLBACK_GEMINI_MODEL})로 마지막 시도`);
          return await ai.models.generateContent({ ...params, model: FALLBACK_GEMINI_MODEL });
        }
        throw err;
      }
      const delayMs = 800 * (attempt + 1); // 800ms, 1600ms ... 점점 늘려가며 재시도
      console.warn(`[Gemini] 일시적 오류로 ${delayMs}ms 후 재시도 (${attempt + 1}/${maxRetries}):`, message.slice(0, 200));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// [추가] 이미지 data URL에서 실제 MIME 타입을 읽는다 (예전엔 모든 이미지를 jpeg로 고정해서 보냈다)
function imageMimeOf(dataUrl: string): string {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(dataUrl || '');
  const t = m ? m[1].toLowerCase() : 'image/jpeg';
  return ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(t) ? t : 'image/jpeg';
}

// [추가] Gemini 응답을 JSON으로 강제한다 (프롬프트로 "JSON만 달라"고 부탁하는 것보다 안정적)
const JSON_CONFIG = { responseMimeType: 'application/json', temperature: 0 };

// [추가] 응답 텍스트에서 JSON 객체를 꺼낸다. 백틱/앞뒤 잡문이 섞여도 최대한 복구하고, 실패하면 null.
function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = (text || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // 다음 후보로
    }
  }
  return null;
}

// [추가] Google Cloud Vision 문자 인식(DOCUMENT_TEXT_DETECTION)으로 영수증 텍스트만 뽑는다. 실패하면 빈 문자열.
async function visionOcrText(dataUrl: string): Promise<string> {
  const key = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!key || !dataUrl) return '';
  try {
    const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: dataUrl.replace(/^data:image\/\w+;base64,/, '') }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }]
      })
    });
    if (!r.ok) return '';
    const j = (await r.json()) as { responses?: Array<{ fullTextAnnotation?: { text?: string }; textAnnotations?: Array<{ description?: string }> }> };
    const first = j.responses?.[0];
    return first?.fullTextAnnotation?.text || first?.textAnnotations?.[0]?.description || '';
  } catch (err) {
    console.error('Vision 영수증 문자 인식 실패:', err);
    return '';
  }
}

// [추가] 문자 인식 텍스트에서 금액·날짜·상호를 규칙으로 뽑는다. Gemini를 못 쓸 때의 최소 대체 결과.
// 금액은 "합계/결제금액" 줄을 우선하고, 없으면 텍스트 안의 가장 큰 금액을 쓴다. 결과는 추정치라 ocrFallback 표시를 붙인다.
function extractReceiptFromOcrText(text: string, context?: string): Record<string, unknown> | null {
  const src = (text || '').trim();
  if (!src) return null;
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const moneyOf = (s: string): number => {
    let best = 0;
    for (const m of s.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,})\s*원?/g)) {
      if (/^0\d/.test(m[1])) continue; // 전화번호·사업자번호 같은 0으로 시작하는 숫자 제외
      const v = Number(m[1].replace(/,/g, ''));
      if (v >= 100 && v < 100000000 && v > best) best = v;
    }
    return best;
  };
  const totalLine = lines.find((l) => /(합\s*계|결제\s*금액|승인\s*금액|판매\s*금액|total|amount)/i.test(l));
  let amount = (totalLine && moneyOf(totalLine)) || 0;
  if (!amount) amount = Math.max(0, ...lines.map(moneyOf));

  let date = '';
  const dm = src.match(/(20\d{2})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/);
  if (dm) date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;

  const merchantName = lines.find((l) =>
    /[가-힣A-Za-z]/.test(l) && !/\d{2,}/.test(l) && l.length >= 2 && l.length <= 30 &&
    !/(영수증|receipt|사업자|대표|tel|전화|카드|승인|합계)/i.test(l)
  ) || '';

  return {
    amount,
    date: date || new Date().toISOString().split('T')[0],
    merchantName,
    memo: '문자 인식(OCR)으로 자동 채움 - 금액과 날짜를 꼭 확인해 주세요',
    category: context === 'overseas_trip' ? '기타' : 'other',
    payMethod: context === 'overseas_trip' ? '신용카드' : 'company_card',
    ocrFallback: true
  };
}

// [추가] Base64 인코딩된 이미지의 실제 크기를 계산하고 5MB 제한을 확인하는 헬퍼 함수
// Base64 문자열: 원본 크기 ≈ Base64 길이 * 3/4 (패딩 제외하면 더 정확함)
function validateImageSize(base64String: string, maxSizeMB: number = 5): { valid: boolean; sizeMB?: number; error?: string } {
  try {
    // base64 프리픽스 제거 (data:image/jpeg;base64, 등)
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
    // Base64 디코딩 후 바이트 크기 계산
    const binaryString = Buffer.from(base64Data, 'base64').toString('binary');
    const sizeBytes = binaryString.length;
    const sizeMB = sizeBytes / (1024 * 1024);

    if (sizeMB > maxSizeMB) {
      return {
        valid: false,
        sizeMB: Math.round(sizeMB * 100) / 100,
        error: `이미지 크기가 ${maxSizeMB}MB를 초과했습니다 (현재: ${Math.round(sizeMB * 100) / 100}MB).`
      };
    }
    return { valid: true, sizeMB: Math.round(sizeMB * 100) / 100 };
  } catch (err) {
    return { valid: false, error: '이미지 크기 검증 중 오류가 발생했습니다.' };
  }
}

// [추가] 파일 타입 검증 (Base64 헤더 확인)
function validateFileType(base64String: string, expectedType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'): { valid: boolean; error?: string } {
  try {
    // Base64 프리픽스 제거
    const base64Data = base64String.replace(/^data:[^;]+;base64,/, '');

    // Base64 헤더 확인 (MIME 타입별 매직 넘버)
    const headerMap: Record<string, string[]> = {
      'image/jpeg': ['FFD8FF'],           // JPEG 매직 넘버
      'image/png': ['89504E47'],          // PNG 매직 넘버
      'image/webp': ['52494646'],         // RIFF/WebP
      'application/pdf': ['25504446']     // PDF 매직 넘버
    };

    const expectedHeaders = headerMap[expectedType];
    if (!expectedHeaders) {
      return { valid: false, error: '지원하지 않는 파일 타입입니다.' };
    }

    // Base64 첫 6자를 16진수로 변환하여 매직 넘버 확인
    const buf = Buffer.from(base64Data.slice(0, 12), 'base64');
    const hexHeader = buf.toString('hex').toUpperCase().slice(0, 6);

    const isValidType = expectedHeaders.some(h => hexHeader.startsWith(h));
    if (!isValidType) {
      return {
        valid: false,
        error: `파일 타입이 일치하지 않습니다. ${expectedType}를 업로드해주세요.`
      };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: '파일 타입 검증 중 오류가 발생했습니다.' };
  }
}

// [추가] 비밀번호 복잡도 검증
// 최소 8자 + 숫자 1개 + 특수문자 1개 포함 필요
function validatePasswordComplexity(password: string): { valid: boolean; error?: string } {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: '비밀번호가 입력되지 않았습니다.' };
  }

  if (password.length < 8) {
    return { valid: false, error: '비밀번호는 최소 8자 이상이어야 합니다.' };
  }

  // 숫자 포함 확인
  if (!/\d/.test(password)) {
    return { valid: false, error: '비밀번호에는 최소 1개의 숫자(0-9)가 포함되어야 합니다.' };
  }

  // 특수문자 포함 확인 (!@#$%^&*_-=+)
  if (!/[!@#$%^&*_\-=+]/.test(password)) {
    return { valid: false, error: '비밀번호에는 최소 1개의 특수문자(!@#$%^&*_-=+)가 포함되어야 합니다.' };
  }

  return { valid: true };
}

// [추가] SQL 주입 공격 방어
// 사용자 입력값에서 SQL 메타문자를 감지하고 제거/이스케이프
function sanitizeSqlInput(input: unknown): string {
  if (typeof input !== 'string') {
    return String(input || '').trim();
  }

  // SQL 주입 시도 패턴 감지
  const sqlInjectionPatterns = [
    /(\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|EXECUTE|SCRIPT|--|\*|;|\||&&|OR|AND)\b)/gi,
    /('|"|`|\\|\/\/|\#)/g
  ];

  // 위험한 문자 제거
  let sanitized = input.trim();

  // 패턴 감지 시 로깅
  sqlInjectionPatterns.forEach((pattern, idx) => {
    if (pattern.test(sanitized)) {
      console.warn(`[SQL 주입 방지] 위험한 패턴 감지: ${sanitized.substring(0, 50)}...`);
      // 위험한 문자 제거
      sanitized = sanitized.replace(pattern, '');
    }
  });

  return sanitized;
}

// [추가] 이메일 입력값 검증 및 살균
function validateAndSanitizeEmail(email: unknown): { valid: boolean; sanitized?: string; error?: string } {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: '이메일이 입력되지 않았습니다.' };
  }

  const sanitized = email.trim().toLowerCase();

  // 이메일 형식 검증 (RFC 5322 간략화 버전)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(sanitized)) {
    return { valid: false, error: '올바른 이메일 형식이 아닙니다.' };
  }

  // Supabase가 SQL 인젝션 방어하므로, 추가 필터링은 불필요
  return { valid: true, sanitized };
}

// [수정] 사용자 입력 기본 검증
// Supabase가 SQL 인젝션을 자동으로 방어하므로, 사용 편의성을 위해 검증 완화
function validateWhitelistInput(value: unknown, fieldType: 'name' | 'phone' | 'company' | 'slug'): { valid: boolean; error?: string } {
  if (!value || typeof value !== 'string') {
    return { valid: false };
  }

  const trimmed = value.trim();

  // 필드별 길이 제한만 확인
  const limits: Record<string, number> = {
    name: 100,
    phone: 20,
    company: 100,
    slug: 50
  };

  const maxLength = limits[fieldType] || 100;
  if (trimmed.length > maxLength) {
    return {
      valid: false,
      error: `${fieldType}은(는) ${maxLength}자 이내여야 합니다.`
    };
  }

  // slug는 최소 제약만 유지 (URL 안전성)
  if (fieldType === 'slug' && !/^[a-zA-Z0-9_\-]{1,}$/.test(trimmed)) {
    return {
      valid: false,
      error: '주소는 영문, 숫자, 하이픈, 언더스코어만 사용 가능합니다.'
    };
  }

  return { valid: true };
}

// [추가] Gemini API가 실패하면 예전엔 원본 에러 메시지(JSON 통째로, 할당량 정책 URL까지
// 포함된 긴 영어 문구)를 그대로 화면에 보여줬다. 사용자 입장에선 알아볼 수도 없고,
// 앱 화면에 저런 게 그대로 뜨는 건 신뢰도도 떨어뜨린다. 원인 종류별로 짧고 이해하기 쉬운
// 한국어 안내문으로 바꿔주는 공용 함수 — AI를 쓰는 모든 API(명함/영수증 스캔, 테두리
// 감지, 회의록 정리 등)에서 이 함수로 감싸서 응답한다.
function toFriendlyAiErrorMessage(err: unknown): string {
  const message = getErrorMessage(err);
  const isQuotaExhausted = getErrorField(err, 'status') === 429 || getErrorField(err, 'code') === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(message);
  if (isQuotaExhausted) {
    return 'AI 인식 요청이 일시적으로 많아 잠시 지연되고 있습니다. 1분 정도 후 다시 시도해주세요.';
  }
  const isTransient = getErrorField(err, 'status') === 503 || getErrorField(err, 'code') === 503 || /UNAVAILABLE|high demand|overloaded/i.test(message);
  if (isTransient) {
    return 'AI 서버가 일시적으로 혼잡합니다. 잠시 후 다시 시도해주세요.';
  }
  const isSafety = /safety|blocked|SAFETY/i.test(message);
  if (isSafety) {
    return '이미지를 분석할 수 없습니다. 다른 사진으로 다시 시도해주세요.';
  }
  return 'AI 인식 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.';
}

import { createServer as createViteServer } from 'vite';
import { scopeIdForUser, decideSignupRoleAndApproval, isEmailVerified, isValidEmail, validateProfileFields } from './src/authLogic.js';
import { getContactGroupIds } from './src/groupUtils.js';
import { RateLimiter } from './src/rateLimiter.js';
import { issueBillingKey, chargeBilling, generateCustomerKey, generateOrderId, addOneMonth } from './src/billing.js';
import { WorkLogExpense, BusinessCard, ContactGroup, CallRecord, Project, ProjectFollowUp, MyProfile, Vehicle, DrivingLog, VehicleExpense, VehicleMaintenance, MaintenanceInterval, DailyWorkLog, WeeklyWorkLog, WorkLogDayEntry, RegisteredUser, AdvancePaymentSettlement, LeaveRequest, OfficialDocument, ApprovalStep, FeedbackItem, InviteRecord, AdminDoc, Announcement, ChatMessage, ChatGroup, CompanyBranding } from './src/types.js';
import {
  initializeDatabase,
  ensureUsersSeeded,
  ensureScopeInitialized,
  getUsers,
  addUser,
  deleteUser,
  deleteScopeCompletely,
  saveSession,
  loadSession,
  deleteSession,
  deleteAllSessionsForUser,
  savePasswordResetToken,
  loadPasswordResetToken,
  deletePasswordResetToken,
  deleteAllPasswordResetTokensForUser,
  logAudit,
  getAuditLogs,
  getScopedCollection,
  getScopedDoc,
  setScopedDoc,
  setScopedDocs,
  setScopedProfile,
  updateScopedDoc,
  deleteScopedDoc,
  replaceScopedCollection,
  findProfileByShareSlug,
  uploadDataUrlImage,
  uploadDataUrlFile,
  getPlatformStats,
  createReferral,
  markReferralRewarded,
  getReferralsForUser,
  migrateScopedItemsToAppUsers
} from './src/db/neonStore.js';





// Gemini 응답 중 그라운딩(출처) 정보만 정의한다
interface GeminiGroundingResponse {
  candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> } }>;
}

// 회사 설정(companySettings) 문서 중 서버가 읽고 쓰는 필드
interface CompanySettingsDoc {
  id?: string;
  address?: string;
  businessType?: string;
  phone?: string;
  fax?: string;
  email?: string;
  docPrefix?: string;
  [key: string]: unknown;
}

// 카카오 로컬 API 응답 중 서버에서 쓰는 부분만 정의한다
interface KakaoLocalResponse {
  documents?: Array<{
    x: string;
    y: string;
    place_name?: string;
    road_address_name?: string;
    address_name?: string;
  }>;
}

// 요청 객체에 미들웨어가 붙이는 값들의 타입 (any 대신 사용)
declare global {
  namespace Express {
    interface Request {
      scopeId?: string;
      caldavUser?: RegisteredUser;
    }
  }
}

const app = express();
const PORT = Number(process.env.PORT) || 8080;

// [추가] 필수 환경 변수 검증
const requiredEnvVars = [
  'CRON_SECRET',
  'TOSS_SECRET_KEY',
  'BREVO_API_KEY',
  'DATABASE_URL',
  'APP_BASE_URL'
  // GEMINI_API_KEY: 선택사항 (AI 기능에만 필요)
  // KAKAO_REST_API_KEY: 선택사항 (지도 기능에만 필요)
];

const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error('❌ 필수 환경 변수 누락:', missingEnvVars.join(', '));
  console.error('서버를 시작할 수 없습니다. .env 파일을 확인해주세요.');
  process.exit(1);
}

console.log('✅ 모든 필수 환경 변수 설정됨');
console.log(`🚀 환경: ${process.env.NODE_ENV || 'development'}`);
console.log(`🔗 APP_BASE_URL: ${process.env.APP_BASE_URL}`);

// [추가] Neon 데이터베이스 초기화
(async () => {
  try {
    await initializeDatabase();
    console.log('✅ Neon 데이터베이스 초기화 완료');
  } catch (err) {
    console.error('❌ 데이터베이스 초기화 실패:', err);
    // process.exit(1) 제거됨 - 서버가 DB 실패에도 포트 8080에서 리스닝을 시작해야 함
  }
})();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// [수정] CORS 설정: 허용할 도메인 명시
// [수정] 개발 환경(localhost)과 프로덕션 도메인(app.bizcardai.kr, onrender.com)을 모두 허용
const allowedOrigins = [
  'http://localhost:5173',       // 개발: Vite
  'http://localhost:3000',       // 개발: 대체 포트
  'https://app.bizcardai.kr',    // 프로덕션: 메인 도메인
  'https://bizcard-pro.onrender.com',  // 프로덕션: Render 기본 URL
  process.env.APP_BASE_URL       // 환경변수로 추가 도메인 지원
];

app.use(cors({
  origin: (origin, callback) => {
    // origin이 없으면(같은 도메인) 허용
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-cron-secret'],
  maxAge: 3600
}));

// [수정] 예전엔 contentSecurityPolicy를 완전히 꺼뒀다 - 지도(Kakao), 카카오 공유 SDK,
// 토스페이먼츠 결제창, Supabase Storage(영수증/명함 이미지), OpenCV.js CDN 폴백처럼 이
// 앱이 실제로 쓰는 외부 출처를 하나하나 정리하지 않은 채로 CSP부터 켜면, 그런 리소스들이
// 조용히 막혀서 지도나 결제, 이미지가 안 뜨는 식으로 화면이 깨질 수 있었기 때문이다.
// 이제 코드 전체를 훑어서 실제로 쓰는 외부 출처를 아래처럼 정리했다. 다만 카카오 지도
// SDK가 내부적으로 호출하는 지도 타일/이미지 서버 도메인까지는 100% 확신할 수 없어서,
// 처음부터 강제 차단(enforce)하지 않고 reportOnly를 환경에 따라 설정한다 - 개발 환경에서는
// 보고만 하고, 프로덕션에서는 실제로 차단한다.
// 한동안 실제 사용(지도 열기, 카톡 공유, 결제, 영수증 스캔 등)해보면서 콘솔에 위반 기록이
// 안 쌓이면, reportOnly를 false로 바꾸면 실제로 차단하는 모드로 전환된다.
app.use(helmet({
  contentSecurityPolicy: {
    reportOnly: process.env.NODE_ENV !== 'production',
    directives: {
      defaultSrc: ["'self'"],
      // 카카오 지도 SDK, 카카오톡 공유 SDK, 토스페이먼츠 결제창, OpenCV.js CDN 폴백
      scriptSrc: ["'self'", 'https://dapi.kakao.com', 'https://t1.kakaocdn.net', 'https://js.tosspayments.com', 'https://docs.opencv.org'],
      // Pretendard 폰트(jsdelivr)와, React의 style={{...}} 인라인 스타일 속성 자체를 허용
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
      // QR코드 생성 이미지, Supabase Storage(영수증/명함/서명 이미지), 카카오 지도 타일/아이콘,
      // base64(data:)·캔버스 캡처(blob:) 이미지
      imgSrc: ["'self'", 'data:', 'blob:', 'https://api.qrserver.com', 'https://*.supabase.co', 'https://*.kakaocdn.net', 'https://*.daumcdn.net'],
      // 카카오 지도/공유 SDK와 Supabase, 토스페이먼츠가 내부적으로 호출하는 API
      connectSrc: ["'self'", 'https://dapi.kakao.com', 'https://*.kakaocdn.net', 'https://*.daumcdn.net', 'https://*.supabase.co', 'https://api.tosspayments.com'],
      frameSrc: ["'self'", 'https://js.tosspayments.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  // 카카오/토스 등 외부 이미지·리소스에 CORP(Cross-Origin-Resource-Policy) 헤더가 없으면
  // 이 옵션이 로딩 자체를 막을 수 있어서 계속 꺼둔다.
  crossOriginEmbedderPolicy: false
}));

// [추가] 배포 플랫폼(Render 등)이나 외부 모니터링/핑 서비스가 "서버가 살아있는지"만 빠르게
// 확인할 수 있는 엔드포인트. 로그인/DB 조회 없이 즉시 응답한다. 5~10분 간격으로 이 주소에
// 외부에서 핑을 보내면, 무료 요금제의 "일정 시간 뒤 서버가 잠드는" 문제도 줄일 수 있다.
// [추가] 매우 간단한 diagnostics 엔드포인트
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// [수정] 상세한 헬스 체크 엔드포인트
app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
      version: 'v1.0.0-sync-startup', // 버전 추적
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      database: process.env.DATABASE_URL ? 'configured' : 'not configured',
      monitoring: SENTRY_DSN ? 'enabled' : 'disabled',
      server: {
        started: true,
        synchronous: true,
        bootstrapRunning: true
      }
    };

    res.status(200).json(health);
  } catch (err) {
    console.error('Health check error:', err);
    res.status(503).json({
      status: 'error',
      message: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// [추가] Swagger API 문서화
// OpenAPI 3.0 명세로 자동 생성된 API 문서를 /api-docs 경로에서 확인 가능
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'BizCard API',
      version: '1.0.0',
      description: 'BizCard - AI 명함 & CRM 통합 솔루션 API 문서'
    },
    servers: [
      {
        url: process.env.APP_BASE_URL || 'http://localhost:3000',
        description: '프로덕션 서버'
      },
      {
        url: 'http://localhost:3000',
        description: '개발 서버'
      }
    ],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sessionId',
          description: '세션 기반 인증 쿠키'
        }
      }
    }
  },
  apis: ['./server.ts'] // JSDoc 주석에서 API 정의 추출
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ------------------------------------------------------------------
// 🔐 세션 인증 (보안 수정)
// [수정] 예전에는 클라이언트가 보내는 x-user-id 헤더를 그대로 신뢰했습니다.
// 이 헤더는 브라우저 개발자도구/curl로 누구나 원하는 값으로 바꿔 보낼 수 있고,
// 가입 시 생성되는 아이디(user-${Date.now()})도 예측이 쉬워서, 다른 사람(심지어
// 관리자 계정)의 아이디만 알면 그 사람으로 완전히 위장해 데이터를 읽고 쓸 수
// 있는 심각한 취약점이었습니다.
// 이제는 로그인/회원가입 성공 시에만 서버가 임의의(예측 불가능한) 세션 토큰을
// 발급해서 httpOnly 쿠키로 내려주고, 이후 모든 요청은 그 쿠키를 검증해서만
// 사용자를 식별합니다. 라우트 코드 자체는 그대로 req.headers['x-user-id']를
// 읽지만, 이 값은 이제 "검증된 세션"에서만 채워지고, 세션이 없거나 유효하지
// 않으면 클라이언트가 뭘 보내든 무시(삭제)됩니다.
// ------------------------------------------------------------------
const SESSION_COOKIE_NAME = 'bizcard_session';
const SESSION_TTL_LONG_MS = 30 * 24 * 60 * 60 * 1000; // 30일 ("로그인 상태 유지" 체크 시)
const SESSION_TTL_SHORT_MS = 24 * 60 * 60 * 1000; // 1일 (체크 안 하면 — 공용 PC 등에서 오래 남는 것 방지)

// [수정] 세션을 메모리에만 두면, Render 같은 배포 플랫폼이 일정 시간 뒤 서버를 재웠다가
// 다음 요청에 다시 깨울 때(cold start) 메모리가 초기화되면서 로그인이 전부 끊긴다.
// 접속이 뜸한 모바일에서 특히 자주 겪는 문제였다. 이제 진짜 저장소는 Supabase의
// app_sessions 테이블이고, 이 Map은 매 요청마다 DB를 조회하지 않도록 돕는 "캐시"일 뿐이다.
// Supabase가 설정 안 된 환경(로컬 개발 등)에서는 예전처럼 메모리로만 동작한다.
const sessions = new Map<string, { userId: string; expiresAt: number }>();

// [수정] "로그인 상태 유지"를 체크했으면 30일, 안 했으면 1일짜리 세션을 발급한다.
// 기본값은 true(기존 동작과 동일하게 30일)로 둬서, 이 옵션을 안 보내는 예전 클라이언트도
// 그대로 잘 동작한다.
async function createSession(userId: string, rememberMe: boolean = true): Promise<{ token: string; ttlMs: number }> {
  const token = crypto.randomBytes(32).toString('hex'); // 256비트 무작위 값 → 추측 불가능
  const ttlMs = rememberMe ? SESSION_TTL_LONG_MS : SESSION_TTL_SHORT_MS;
  const expiresAt = Date.now() + ttlMs;
  sessions.set(token, { userId, expiresAt });
  await saveSession(token, userId, expiresAt); // Supabase에 영구 저장 (미설정 시 조용히 무시됨)
  return { token, ttlMs };
}

// [수정] 비밀번호를 재설정할 때 호출: 그 사용자 명의로 발급된 기존 세션을 전부 끊는다.
// 계정이 탈취당해 공격자가 이미 로그인 세션을 갖고 있는 경우, 비밀번호만 바꾸고
// 세션은 그대로 두면 공격자는 계속 접근할 수 있다 — 그래서 재설정 성공 시점에
// "이 사용자의 세션은 전부 무효"로 만들어야 실제로 안전해진다.
async function invalidateAllSessionsForUser(userId: string): Promise<void> {
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId) sessions.delete(token);
  }
  await deleteAllSessionsForUser(userId);
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

// [수정] 예전엔 이 쿠키에 Secure 옵션을 붙일지 말지를 process.env.NODE_ENV === 'production'
// 하나에만 의존해서 정했다. 이 값은 배포 플랫폼(Render) 대시보드의 환경변수 설정에 달려있는데,
// 실수로 빠뜨리거나 값이 잘못 들어가면 조용히 Secure 옵션 없이 배포될 수 있었다(겉으로는 앱이
// 멀쩡히 잘 돌아가서 알아채기도 어렵다). 이제는 요청이 실제로 HTTPS로 들어왔는지(Render가
// 앞단에서 TLS를 처리하고 붙여주는 x-forwarded-proto 헤더, 또는 req.protocol)를 직접 확인해서
// 정한다 - 환경변수 설정 여부와 무관하게, 실제로 HTTPS 요청이면 항상 Secure를 붙이고,
// 로컬 http 개발 환경에서만 자연스럽게 빠진다. NODE_ENV=production도 신호 중 하나로 같이 보되,
// 어느 한쪽이라도 프로덕션/HTTPS를 가리키면 안전하게 Secure를 붙인다.
function isRequestSecure(req: express.Request): boolean {
  return (
    req.protocol === 'https' ||
    req.get('x-forwarded-proto') === 'https' ||
    process.env.NODE_ENV === 'production'
  );
}

function setSessionCookie(req: express.Request, res: express.Response, token: string, ttlMs: number = SESSION_TTL_LONG_MS) {
  const secureFlag = isRequestSecure(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${secureFlag}`
  );
}

function clearSessionCookie(res: express.Response) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// 모든 요청보다 먼저 실행: 쿠키의 세션을 검증하고, 그 결과로만 x-user-id를 채운다.
app.use(async (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  let session = token ? sessions.get(token) : undefined;

  // [수정] 메모리 캐시에 없으면(=서버가 방금 재시작돼서 캐시가 비어있는 경우 포함)
  // Supabase에서 한 번 더 확인한다. 여기서 찾으면 캐시에도 채워둬서 다음 요청부터는
  // 다시 DB를 안 타도 되게 한다. 이 한 단계 덕분에 서버 재시작 후 첫 요청에서도
  // 로그인이 안 끊긴다.
  if (!session && token && process.env.DATABASE_URL) {
    const stored = await loadSession(token);
    if (stored) {
      session = { userId: stored.userId, expiresAt: stored.expiresAt };
      sessions.set(token, session);
    }
  }

  if (session && session.expiresAt > Date.now()) {
    // 세션이 유효하면, 클라이언트가 헤더에 뭘 보냈든 무시하고 서버가 확인한 사용자로 덮어쓴다.
    req.headers['x-user-id'] = session.userId;
  } else {
    if (token) {
      sessions.delete(token); // 만료된 세션 정리
      deleteSession(token).catch(() => {}); // Supabase 쪽도 정리 (실패해도 요청 흐름은 막지 않음)
    }
    // 유효한 세션이 없으면 클라이언트가 임의로 넣은 x-user-id는 절대 신뢰하지 않는다.
    delete req.headers['x-user-id'];
  }
  next();
});

// === 통합 차량 관리 초기 데이터 정의 ===
const initialVehicles: Vehicle[] = [
  {
    id: 'vh-1',
    modelName: '벤츠 E300 4Matic',
    plateNumber: '12가 3456',
    owner: '박영록',
    purchaseDate: '2025-03-10',
    initialMileage: 12400,
    currentMileage: 12500,
    fuelType: 'gasoline',
    status: 'active',
    createdAt: new Date('2025-03-10').toISOString()
  },
  {
    id: 'vh-2',
    modelName: '현대 그랜저 하이브리드',
    plateNumber: '34너 5678',
    owner: '이지민',
    purchaseDate: '2026-01-15',
    initialMileage: 8385,
    currentMileage: 8400,
    fuelType: 'hybrid',
    status: 'active',
    createdAt: new Date('2026-01-15').toISOString()
  },
  {
    id: 'vh-3',
    modelName: '기아 카니발',
    plateNumber: '56더 7890',
    owner: '박영록',
    purchaseDate: '2024-06-20',
    initialMileage: 25300,
    currentMileage: 25300,
    fuelType: 'diesel',
    status: 'active',
    createdAt: new Date('2024-06-20').toISOString()
  },
  {
    id: 'vh-4',
    modelName: '테슬라 모델 Y',
    plateNumber: '78러 9012',
    owner: '박영록',
    purchaseDate: '2025-08-05',
    initialMileage: 11190,
    currentMileage: 11200,
    fuelType: 'electric',
    status: 'active',
    createdAt: new Date('2025-08-05').toISOString()
  },
  {
    id: 'vh-5',
    modelName: '제네시스 G80',
    plateNumber: '90머 1234',
    owner: '한상우',
    purchaseDate: '2025-11-20',
    initialMileage: 15400,
    currentMileage: 15400,
    fuelType: 'gasoline',
    status: 'active',
    createdAt: new Date('2025-11-20').toISOString()
  },
  {
    id: 'vh-6',
    modelName: '현대 아반떼',
    plateNumber: '45서 6789',
    owner: '한상우',
    purchaseDate: '2026-02-18',
    initialMileage: 4190,
    currentMileage: 4200,
    fuelType: 'gasoline',
    status: 'active',
    createdAt: new Date('2026-02-18').toISOString()
  }
];

const initialDrivingLogs: DrivingLog[] = [
  {
    id: 'log-1',
    vehicleId: 'vh-1',
    driverName: '박영록',
    date: '2026-06-30',
    purpose: '거래처 미팅 (삼성전자)',
    startMileage: 12475,
    endMileage: 12500,
    distance: 25,
    startPlace: '회사 본사',
    endPlace: '삼성전자 서초사옥',
    createdAt: new Date('2026-06-30T10:00:00').toISOString()
  },
  {
    id: 'log-2',
    vehicleId: 'vh-2',
    driverName: '이지민',
    date: '2026-06-29',
    purpose: '외근 (네이버 클라우드)',
    startMileage: 8385,
    endMileage: 8400,
    distance: 15,
    startPlace: '회사 본사',
    endPlace: '네이버 분당사옥',
    createdAt: new Date('2026-06-29T14:30:00').toISOString()
  },
  {
    id: 'log-3',
    vehicleId: 'vh-1',
    driverName: '박영록',
    date: '2026-06-28',
    purpose: '현장 실사 및 비즈니스 미팅',
    startMileage: 12455,
    endMileage: 12475,
    distance: 20,
    startPlace: '회사 본사',
    endPlace: '카카오 판교사옥',
    createdAt: new Date('2026-06-28T09:00:00').toISOString()
  },
  {
    id: 'log-4',
    vehicleId: 'vh-6',
    driverName: '한상우',
    date: '2026-06-27',
    purpose: '업무 관련 물품 및 소모품 구입',
    startMileage: 4190,
    endMileage: 4200,
    distance: 10,
    startPlace: '회사 본사',
    endPlace: '이마트 자양점',
    createdAt: new Date('2026-06-27T16:00:00').toISOString()
  },
  {
    id: 'log-5',
    vehicleId: 'vh-4',
    driverName: '박영록',
    date: '2026-06-26',
    purpose: '정기 주주총회 참석 의전 및 이동',
    startMileage: 11190,
    endMileage: 11200,
    distance: 10,
    startPlace: '회사 본사',
    endPlace: '포스코센터',
    createdAt: new Date('2026-06-26T11:00:00').toISOString()
  }
];

const initialExpenses: VehicleExpense[] = [
  {
    id: 'exp-1',
    vehicleId: 'vh-1',
    date: '2026-06-29',
    category: 'fuel',
    amount: 75000,
    memo: '벤츠 고급유 주유 (SK에너지)',
    createdAt: new Date('2026-06-29T18:30:00').toISOString()
  },
  {
    id: 'exp-2',
    vehicleId: 'vh-1',
    date: '2026-06-30',
    category: 'toll',
    amount: 4800,
    memo: '경부고속도로 통행료 회계 정산',
    createdAt: new Date('2026-06-30T11:15:00').toISOString()
  },
  {
    id: 'exp-3',
    vehicleId: 'vh-2',
    date: '2026-06-28',
    category: 'parking',
    amount: 12000,
    memo: '강남구청 공영주차장 주차비',
    createdAt: new Date('2026-06-28T15:00:00').toISOString()
  },
  {
    id: 'exp-4',
    vehicleId: 'vh-6',
    date: '2026-06-27',
    category: 'toll',
    amount: 3200,
    memo: '외곽순환도로 톨게이트',
    createdAt: new Date('2026-06-27T17:00:00').toISOString()
  },
  {
    id: 'exp-5',
    vehicleId: 'vh-3',
    date: '2026-06-25',
    category: 'other',
    amount: 26749,
    memo: '카니발 프리미엄 세차 및 소모성 클리너 구입',
    createdAt: new Date('2026-06-25T14:00:00').toISOString()
  }
];

const initialMaintenances: VehicleMaintenance[] = [
  {
    id: 'maint-1',
    vehicleId: 'vh-1',
    date: '2026-06-15',
    title: '정기 점검 (엔진오일 및 필터 교체)',
    cost: 180000,
    mileage: 12000,
    shopName: '메르세데스벤츠 공식 강남서비스센터',
    status: 'completed',
    memo: '다음 오일 교환 예정일: 22,000km 시점',
    createdAt: new Date('2026-06-15').toISOString()
  },
  {
    id: 'maint-2',
    vehicleId: 'vh-4',
    date: '2026-07-15',
    title: '하절기 에어컨 항균 필터 및 타이어 위치 교환',
    cost: 35000,
    mileage: 12000,
    shopName: '테슬라 공식 성수서비스센터',
    status: 'scheduled',
    memo: '사전 예약 완료 (14:00)',
    createdAt: new Date('2026-06-20').toISOString()
  }
];

// 내 명함 프로필 초기 데이터
const initialMyProfile: MyProfile = {
  name: '박영록',
  company: 'BizCard',
  department: '글로벌 사업총괄본부',
  title: '대표이사 / CEO',
  phoneMobile: '010-5454-0000',
  phoneOffice: '02-545-0000',
  phoneFax: '02-545-0001',
  email: 'sample@example.com',  // ✅ 샘플 이메일 (실제 사용자가 설정)
  address: '서울특별시 강남구 테헤란로 152 강남파이낸스센터 18층',
  snsUrl: 'https://linkedin.com/in/bizcard-pro',
  website: 'https://bizcard-pro.ai',
  memo: '스마트 명함 관리 & AI OCR 솔루션 전문가'
};

// 초기 프로젝트 샘플 데이터
const initialProjects: Project[] = [
  {
    id: 'p-1',
    name: '삼성전자 온디바이스 B2B 공급 제안',
    developer: '삼성전자 (MX사업부)',
    contractor: '시공테크',
    architect: '건원건축',
    electricalDesigner: '한일전기설계',
    mechanicalDesigner: '삼신설계',
    supervisor: '한미글로벌',
    operator: 'BizCard',
    status: 'progress',
    priority: 'high',
    dueDate: new Date(Date.now() + 86400000 * 14).toISOString().split('T')[0],
    contactIds: ['c-2'],
    budget: '1억 5천만원',
    createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    followUps: [
      {
        id: 'f-1',
        projectId: 'p-1',
        content: '제안 피치덱 수정안 송부 완료 (보안팀 서류 첨부)',
        date: new Date(Date.now() - 86400000 * 2).toISOString().split('T')[0],
        status: 'done'
      },
      {
        id: 'f-2',
        projectId: 'p-1',
        content: '담당 임원 대면 프리젠테이션 미팅',
        date: new Date(Date.now() + 86400000 * 5).toISOString().split('T')[0],
        status: 'planned'
      }
    ]
  },
  {
    id: 'p-2',
    name: '네이버 클라우드 API 연동 파트너십 계약',
    developer: '네이버클라우드 (주)',
    contractor: '우미건설',
    architect: '희림건축',
    electricalDesigner: '세명전기엔지니어링',
    mechanicalDesigner: '우원엠앤이',
    supervisor: '건원엔지니어링',
    operator: '네이버클라우드 운영본부',
    status: 'progress',
    priority: 'high',
    dueDate: new Date(Date.now() + 86400000 * 7).toISOString().split('T')[0],
    contactIds: ['c-1'],
    budget: '8,000만원',
    createdAt: new Date(Date.now() - 86400000 * 15).toISOString(),
    followUps: [
      {
        id: 'f-3',
        projectId: 'p-2',
        content: '기술 미팅 아젠다 확정 및 요금표 최종 협의',
        date: new Date(Date.now() - 86400000 * 1).toISOString().split('T')[0],
        status: 'done'
      }
    ]
  },
  {
    id: 'p-3',
    name: 'LG CNS 스마트 물류 시범 구축 사업',
    developer: 'LG CNS',
    contractor: 'GS건설',
    architect: '창조건축',
    electricalDesigner: '동일전기설계',
    mechanicalDesigner: '삼우엠앤이',
    supervisor: '토펙엔지니어링',
    operator: 'LG CNS 물류사업본부',
    status: 'opportunity',
    priority: 'medium',
    dueDate: new Date(Date.now() + 86400000 * 30).toISOString().split('T')[0],
    contactIds: ['c-5'],
    budget: '5,000만원',
    createdAt: new Date(Date.now() - 86400000 * 4).toISOString(),
    followUps: []
  }
];

// 초기 그룹 샘플 데이터
const initialGroups: ContactGroup[] = [
  { id: 'g-vip', name: '⭐ VIP 거래처', color: 'bg-amber-500 text-amber-950 border-amber-400' },
  { id: 'g-client', name: '💼 비즈니스 파트너', color: 'bg-blue-500 text-white border-blue-400' },
  { id: 'g-tech', name: '💻 테크 / 개발', color: 'bg-emerald-500 text-white border-emerald-400' },
  { id: 'g-friend', name: '🤝 지인 / 네트워킹', color: 'bg-purple-500 text-white border-purple-400' },
];

// 초기 연락처 명함 샘플 데이터 (내 위치 기준 대략적인 서울/경기 좌표 포함)
const initialContacts: BusinessCard[] = [
  {
    id: 'c-1',
    name: '김도현',
    company: '네이버 클라우드',
    department: 'AI 플랫폼 개발팀',
    title: '수석 연구원',
    phoneMobile: '010-3456-7890',
    phoneOffice: '031-784-1114',
    phoneFax: '031-784-1115',
    email: 'dohyun.kim@navercorp.com',
    address: '경기도 성남시 분당구 분당내곡로 131 테크원 타워',
    lat: 37.3948,
    lng: 127.1112,
    groupId: 'g-tech',
    frontImage: 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?auto=format&fit=crop&w=600&q=80',
    backImage: 'https://images.unsplash.com/photo-1557683316-973673baf926?auto=format&fit=crop&w=600&q=80',
    memo: '하이퍼클로바X B2B API 연동 논의. 다음 달 미팅 예정.',
    companyInfo: '국내 최대 규모의 초대규모 AI(하이퍼클로바X) 및 클라우드 인프라 플랫폼 기업 (전년도 매출액 약 1조 1,400억원)',
    createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
    callHistory: [
      {
        id: 'call-1',
        contactId: 'c-1',
        type: 'incoming',
        timestamp: new Date(Date.now() - 3600000 * 4).toISOString(),
        duration: '6분 42초',
        note: 'API 스펙 문서 메일로 송부 요청받음'
      },
      {
        id: 'call-2',
        contactId: 'c-1',
        type: 'outgoing',
        timestamp: new Date(Date.now() - 86400000 * 2).toISOString(),
        duration: '12분 10초',
        note: '기술 미팅 아젠다 조율'
      }
    ]
  },
  {
    id: 'c-2',
    name: '이서연',
    company: '삼성전자',
    department: 'DX부문 모바일경험(MX)사업부',
    title: '책임 프로덕트 매니저',
    phoneMobile: '010-9876-5432',
    phoneOffice: '02-2255-0114',
    phoneFax: '02-2255-0115',
    email: 'seoyeon.lee@samsung.com',
    address: '서울특별시 서초구 서초대로74길 11 삼성전자 서초사옥',
    lat: 37.4967,
    lng: 127.0276,
    groupId: 'g-client',
    frontImage: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=600&q=80',
    memo: '갤럭시 온디바이스 명함 스캔 솔루션 도입 협의 중.',
    companyInfo: '삼성그룹 계열의 글로벌 전자제품 및 반도체 제조 부동의 1위 대기업 (전년도 매출액 약 258조원)',
    createdAt: new Date(Date.now() - 86400000 * 4).toISOString(),
    callHistory: []
  },
  {
    id: 'c-3',
    name: '정민우',
    company: '카카오',
    department: '로컬서비스 기획팀',
    title: '파트장',
    phoneMobile: '010-1234-5678',
    phoneOffice: '02-1577-3754',
    phoneFax: '02-1577-3755',
    email: 'minwoo.jung@kakaocorp.com',
    address: '제주특별자치도 제주시 첨단로 242',
    lat: 33.4724,
    lng: 126.5794,
    groupId: 'g-tech',
    frontImage: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=600&q=80',
    memo: '카카오 맵 API 고도화 및 비즈니스 명함 동기화 연동 제안 예정.',
    companyInfo: '대한민국의 대표 모바일 플랫폼 및 메신저 기반 생활 밀착형 서비스 IT 대기업 (전년도 매출액 약 8조원)',
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    callHistory: []
  },
  {
    id: 'c-4',
    name: '최유리',
    company: '토스(비바리퍼블리카)',
    department: '브랜드 디자인 그룹',
    title: '브랜드 매니저',
    phoneMobile: '010-8765-4321',
    phoneOffice: '02-1599-1111',
    phoneFax: '02-1599-2222',
    email: 'yuri.choi@toss.im',
    address: '서울특별시 강남구 테헤란로 142 아크플레이스 12층',
    lat: 37.4994,
    lng: 127.0358,
    groupId: 'g-friend',
    frontImage: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=600&q=80',
    memo: 'Toss B2B 마케팅 협업 관련 연락망 구축.',
    companyInfo: '대한민국의 대표 종합 금융 핀테크 플랫폼 비바리퍼블리카 운영 기업 (전년도 매출액 약 1조 3,000억원)',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    callHistory: []
  },
  {
    id: 'c-5',
    name: '강태오',
    company: 'LG CNS',
    department: '스마트 팩토리 사업부',
    title: '파트장',
    phoneMobile: '010-5555-5555',
    phoneOffice: '02-2099-0114',
    phoneFax: '02-2099-0115',
    email: 'teoh.kang@lgcns.com',
    address: '서울특별시 강서구 마곡중앙8로 71 LG사이언스파크',
    lat: 37.5615,
    lng: 126.8335,
    groupId: 'g-tech',
    frontImage: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=600&q=80',
    memo: '스마트 물류 시범 구축 사업 관련 명함 확보.',
    companyInfo: 'LG그룹의 IT 서비스 및 시스템 통합(SI), 디지털 트랜스포메이션 전문 대기업 (전년도 매출액 약 5조 2,000억원)',
    createdAt: new Date(Date.now() - 86400000 * 1).toISOString(),
    callHistory: []
  }
];

const initialDailyLogs: DailyWorkLog[] = [
  {
    id: 'dl-1',
    date: new Date().toISOString().split('T')[0],
    title: '삼성전자 MX사업부 솔루션 제안 미팅 및 추가 요구 검토',
    author: '한상우',
    department: '비즈니스전략팀',
    tasksToday: '1. 삼성전자 서초사옥 방문 미팅 진행 및 온디바이스 데모 시연 완료\n2. 고객 보안 가이드 및 규정 준수를 위한 추가 요건 메일 조율 완료',
    tasksTomorrow: '1. 내부 개발 본부와 삼성전자 측 보안 가이드 기술 타당성 검토 회의 진행\n2. 2차 미팅용 수정 제안서 초안 작성 및 피치덱 업데이트',
    issues: '기존 클라우드 전송 방식 외에 완전한 온디바이스 파싱 옵션을 요청함. 추가적인 라이브러리 가벼움 및 디바이스 연산 부하 테스트가 관건임.',
    contactIds: ['c-2'],
    projectIds: ['p-1'],
    createdAt: new Date().toISOString()
  },
  {
    id: 'dl-2',
    date: new Date(Date.now() - 86400000).toISOString().split('T')[0],
    title: '네이버 클라우드 API 연동 요금제 조율 및 설계 회의',
    author: '한상우',
    department: '비즈니스전략팀',
    tasksToday: '1. 네이버 클라우드 김도현 수석 연구원과 유선 통화로 연동 스펙 아젠다 조율\n2. B2B 주소록 자동 동기화 기능에 관한 API 트래픽 한도 및 요금 정책 최종 타협안 도출\n3. 내부 보고용 기안서 작성',
    tasksTomorrow: '1. 파트너십 최종 계약서 초안 법무 검토 요청\n2. 신규 API 연동을 위한 인프라 리소스 배치 계획 수립',
    issues: '트래픽 급증 시의 레이턴시 보장을 위한 전용 회선 옵션 추가 논의가 일부 남아있음.',
    contactIds: ['c-1'],
    projectIds: ['p-2'],
    createdAt: new Date(Date.now() - 86400000).toISOString()
  }
];

const initialWeeklyLogs: WeeklyWorkLog[] = [
  {
    id: 'wl-1',
    startDate: new Date(Date.now() - 86400000 * 6).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    title: '6월 4주차 주간 업무 보고 (영업 총괄 및 솔루션 파트너십)',
    author: '한상우',
    department: '비즈니스전략팀',
    achievementsThisWeek: '1. 삼성전자 MX사업부 B2B 솔루션 온디바이스 데모 미팅 수행 (성공적 피드백)\n2. 네이버 클라우드 연동 요금 정책 협상 타결 (B2B 주소록 동기화 핵심 아젠다 해결)\n3. 신규 VIP 명함 5건 등록 및 고객 CRM 매핑 완료',
    achievementsByDay: {
      mon: '1. 주간 영업 실적 보고 회의 참석\n2. 주요 VIP 고객 메일 피드백 정리 및 금주 타겟 명단 선정',
      tue: '1. 네이버 클라우드 김도현 수석 연구원과 유선 요금 및 API 연동 아젠다 사전 조율\n2. 신규 파트너용 기획 설명서 보정 작업 완료',
      wed: '1. 네이버 클라우드 B2B 주소록 자동 동기화 기능 한도 및 API 요금 최종 타결안 도출\n2. 내부 보고용 상신 기안서 기안 완료',
      thu: '1. 삼성전자 서초사옥 이서연 책임 PM 방문 대면 제안 미팅 및 온디바이스 데모 시연 진행\n2. 고객 보안 가이드 추가 요구사항 수신',
      fri: '1. 삼성전자 2차 미팅 대안(보안 연산 부하 가이드 및 라이브러리 경량화) 기술 분석 의뢰\n2. 신규 인맥 5건 시스템 등록 및 CRM 정보 기재 완료',
      sat: '',
      sun: ''
    },
    plansNextWeek: '1. 삼성전자 보안 요구 기술 미팅 진행 및 완전 온디바이스 옵션 아키텍처 제안서 작성\n2. 네이버 클라우드 파트너십 최종 계약 서명 조율\n3. 대리점 및 유통 파트너 추가 확보를 위한 컨택 가동',
    feedbacks: '현재 개발팀 리소스가 한정되어 있어, 삼성전자의 완전 온디바이스 요구사항 수용을 위해서는 백엔드 최적화 업무의 우선순위 재조정이 필요함.',
    contactIds: ['c-1', 'c-2'],
    projectIds: ['p-1', 'p-2'],
    createdAt: new Date().toISOString()
  }
];

// 회원 목록 & 협업 스코프 데이터베이스 초기 데이터
const initialUsers: RegisteredUser[] = [
  {
    id: 'user-demo',
    email: 'demo@bizcard.com',
    password: 'demo',
    name: '박영록',
    type: 'individual'
  },
  {
    id: 'user-naver1',
    email: 'partner1@company.com',
    password: 'demo',
    name: '이지민',
    type: 'company',
    companyName: '네이버',
    businessNumber: '123-45-67890'
  },
  {
    id: 'user-naver2',
    email: 'partner2@company.com',
    password: 'demo',
    name: '한상우',
    type: 'company',
    companyName: '네이버',
    businessNumber: '123-45-67890'
  }
];

// ⚠️ [운영 관련 중요 메모 - 2026-08-16] 이 서버는 회원 목록(users)과 스코프별 데이터(db)를
// 전부 "이 프로세스의 메모리"에 캐싱해두고 쓰는 구조입니다. Supabase가 최종 저장소이긴
// 하지만, 매 요청마다 다시 조회하지 않고 메모리 캐시를 읽고, 쓸 때만 메모리 + Supabase를
// 동시에 갱신합니다(아래 addUser/deleteUser, setScopedDoc 등 참고).
//
// 이 구조는 "Render에서 이 서버가 인스턴스 1개로만 돌아간다"는 전제에서만 안전합니다.
// 만약 나중에 트래픽이 늘어서 Render 인스턴스를 2개 이상으로 늘리거나(수동 스케일업,
// 오토스케일링 등) 로드밸런서를 앞에 두게 되면, 인스턴스마다 메모리 캐시가 따로 놀아서
// "A 인스턴스에서 저장한 내용이 B 인스턴스 화면에는 한참 뒤에야(또는 재시작 전까지 계속
// 안) 보이는" 데이터 불일치가 생깁니다. 특히 users 배열은 로그인/권한 판정에 쓰이기 때문에
// 더 치명적일 수 있습니다(예: 관리자가 A 인스턴스에서 동료를 관리자로 바꿨는데 B 인스턴스는
// 여전히 예전 권한으로 판단).
//
// 지금(2026-08-16 기준)은 인스턴스 1개로만 운영하기로 확인했으므로 당장 손댈 필요는
// 없습니다. 인스턴스를 늘릴 계획이 생기면, 이 메모리 캐시를 걷어내고 매 요청마다
// Supabase를 직접 조회하도록(또는 Redis 등 공유 캐시로 교체하도록) 바꿔야 합니다 -
// server.ts 거의 전체의 쓰기 API를 건드려야 하는 큰 작업이라 미리 여유를 두고 계획하는
// 게 좋습니다.
//
// 로컬 사용자 캐시 및 데이터베이스
let users: RegisteredUser[] = [];

const db: { [scopeId: string]: {
  contacts: BusinessCard[];
  projects: Project[];
  groups: ContactGroup[];
  myProfile: MyProfile;
  vehicles: Vehicle[];
  drivingLogs: DrivingLog[];
  expenses: VehicleExpense[];
  maintenances: VehicleMaintenance[];
  maintenanceIntervals: MaintenanceInterval[];
  dailyLogs: DailyWorkLog[];
  weeklyLogs: WeeklyWorkLog[];
  advancePayments: AdvancePaymentSettlement[];
  leaveRequests: LeaveRequest[];
  officialDocuments: OfficialDocument[];
  adminDocs: AdminDoc[];
  announcements: Announcement[];
  chatMessages: ChatMessage[];
  chatGroups: ChatGroup[];
} } = {};

// 스코프(회사/개인 데이터 묶음) 한 개의 데이터 타입
type ScopedData = (typeof db)[string];

// 동시에 여러 요청이 같은 스코프를 불러오려고 하면(예: 페이지 로딩 시 여러 화면이 동시에 호출),
// 각자 따로 전체 재조회를 시작하지 않고 "이미 진행 중인 로딩"에 함께 올라타도록 합니다.
// (안 그러면 응답이 늦어질수록 중복 재시도가 계속 쌓여 Supabase 연결 부담이 눈덩이처럼 커집니다.)
const inFlightScopeLoads: { [scopeId: string]: Promise<typeof db[string]> } = {};

// Supabase로부터 특정 스코프 로드 (스코프당 1회만 로드하여 메모리에 캐시)
async function loadScopeFromSupabase(scopeId: string) {
  if (db[scopeId]) return db[scopeId];
  if (inFlightScopeLoads[scopeId]) return inFlightScopeLoads[scopeId];

  const loadPromise = loadScopeFromSupabaseInner(scopeId).finally(() => {
    delete inFlightScopeLoads[scopeId];
  });
  inFlightScopeLoads[scopeId] = loadPromise;
  return loadPromise;
}

async function loadScopeFromSupabaseInner(scopeId: string) {
  if (db[scopeId]) return db[scopeId];

  // 컬렉션 하나가 느려지거나(DB 타임아웃 등) 응답이 없어도, 다른 화면(예: 내 명함 공유)이
  // 같이 멈추지 않도록 각 컬렉션 조회에 개별 타임아웃을 둡니다. 타임아웃난 컬렉션이 있으면
  // 이번 요청은 빈 목록으로 우선 응답하되, 전체 결과는 캐싱하지 않아 다음 요청에서 다시 시도합니다.
  // [수정] 명함 등 데이터가 1,000건을 넘으면 Supabase 조회 자체가 페이지 단위(1,000건씩)로
  // 여러 번 왕복하게 되면서, 예전 15초 타임아웃으로는 부족해지는 경우가 생겼다(예: 2,100건
  // 짜리 명함 목록은 3번 왕복 필요). 그 결과 "로그인하면 0개로 보이다가, 로그아웃 후 다시
  // 로그인하면 정상적으로 다 보이는"(재시도 때는 운 좋게 시간 안에 끝남) 혼란스러운 증상이
  // 있었다. 데이터가 많을수록 왕복이 늘어나는 걸 감안해 타임아웃을 넉넉하게 늘린다.
  let hadTimeout = false;
  const withTimeout = <T>(promise: Promise<T[]>, label: string, ms = 40000): Promise<T[]> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T[]>((resolve) => {
      timer = setTimeout(() => {
        hadTimeout = true;
        console.error(`getScopedCollection(${scopeId}, ${label}) 타임아웃 - 이번 요청은 빈 목록으로 처리합니다.`);
        resolve([]);
      }, ms);
    });
    // 실제 쿼리가 먼저 끝나도 setTimeout 타이머 자체는 계속 살아있다가 나중에(ms 뒤) 뒤늦게 발동해서,
    // 이미 성공적으로 끝난 요청에 대해서까지 "타임아웃" 에러 로그를 잘못 찍는 버그가 있었다.
    // 어느 쪽이 이기든 결과가 나오는 즉시 타이머를 확실히 정리한다.
    return Promise.race([promise, timeoutPromise]).then((result) => {
      clearTimeout(timer);
      return result;
    });
  };

  // [수정] 예전엔 새로 가입하는 회사/개인 계정마다 개발 중에 쓰던 가짜 샘플 데이터
  // (명함, 프로젝트, 내 프로필 등)가 그대로 복사되어 들어갔다. 실제 서비스 이용자에게는
  // 절대 있으면 안 되는 문제라서, 이제는 전부 빈 상태로 시작하도록 고쳤다.
  // (initialContacts 등 원본 상수는 다른 곳에서 참조하지 않는 한 그대로 남아있어도 무방하다)
  await ensureScopeInitialized(scopeId, {
    contacts: [],
    projects: [],
    groups: JSON.parse(JSON.stringify(initialGroups)),
    myProfile: {
      name: '', company: '', department: '', title: '',
      phoneMobile: '', phoneOffice: '', phoneFax: '', email: '',
      address: '', snsUrl: '', website: '', memo: ''
    },
    vehicles: [],
    drivingLogs: [],
    expenses: [],
    maintenances: [],
    maintenanceIntervals: [],
    dailyLogs: [],
    weeklyLogs: []
  });

  // 11개 컬렉션을 한꺼번에(Promise.all) 동시 요청하면 Supabase(PostgREST)의 커넥션 풀을
  // 순간적으로 다 소모해서, 정작 쿼리 자체는 1ms도 안 걸리는데도 "연결을 못 잡아" 타임아웃이
  // 나는 현상이 있었습니다. 순차적으로 하나씩 조회해 커넥션 풀 부담을 줄입니다.
  const contacts = await withTimeout(getScopedCollection<BusinessCard>(scopeId, 'contacts'), 'contacts');
  const projects = await withTimeout(getScopedCollection<Project>(scopeId, 'projects'), 'projects');
  const groups = await withTimeout(getScopedCollection<ContactGroup>(scopeId, 'groups'), 'groups');
  const vehicles = await withTimeout(getScopedCollection<Vehicle>(scopeId, 'vehicles'), 'vehicles');
  const drivingLogs = await withTimeout(getScopedCollection<DrivingLog>(scopeId, 'drivingLogs'), 'drivingLogs');
  const expenses = await withTimeout(getScopedCollection<VehicleExpense>(scopeId, 'expenses'), 'expenses');
  const maintenances = await withTimeout(getScopedCollection<VehicleMaintenance>(scopeId, 'maintenances'), 'maintenances');
  const maintenanceIntervals = await withTimeout(getScopedCollection<MaintenanceInterval>(scopeId, 'maintenanceIntervals'), 'maintenanceIntervals');
  const dailyLogs = await withTimeout(getScopedCollection<DailyWorkLog>(scopeId, 'dailyLogs'), 'dailyLogs');
  const weeklyLogs = await withTimeout(getScopedCollection<WeeklyWorkLog>(scopeId, 'weeklyLogs'), 'weeklyLogs');
  const advancePayments = await withTimeout(getScopedCollection<AdvancePaymentSettlement>(scopeId, 'advancePayments'), 'advancePayments');
  const leaveRequests = await withTimeout(getScopedCollection<LeaveRequest>(scopeId, 'leaveRequests'), 'leaveRequests');
  const officialDocuments = await withTimeout(getScopedCollection<OfficialDocument>(scopeId, 'officialDocuments'), 'officialDocuments');
  const adminDocs = await withTimeout(getScopedCollection<AdminDoc>(scopeId, 'adminDocs'), 'adminDocs');
  const announcements = await withTimeout(getScopedCollection<Announcement>(scopeId, 'announcements'), 'announcements');
  // [추가] 채팅 메시지는 다른 컬렉션과 달리 시간이 지날수록 계속 쌓이기만 하는 로그성
  // 데이터라서, 전체를 다 불러오면 대화가 오래될수록 매번 로딩이 느려진다. 최근 500건만
  // 캐싱해도 화면(최근 대화 스크롤)에는 충분하다.
  const chatMessages = await withTimeout(getScopedCollection<ChatMessage>(scopeId, 'chatMessages'), 'chatMessages');
  const chatGroups = await withTimeout(getScopedCollection<ChatGroup>(scopeId, 'chatGroups'), 'chatGroups');
  const profileList = await withTimeout(getScopedCollection<MyProfile>(scopeId, 'myProfile'), 'myProfile');

  // ✅ 첫 번째 프로필 사용 (하드코딩된 이메일 제거)
  const myProfile = profileList[0] || initialMyProfile;

  const loadedData = {
    contacts,
    projects,
    groups,
    myProfile,
    vehicles,
    drivingLogs,
    expenses,
    maintenances,
    maintenanceIntervals,
    dailyLogs,
    weeklyLogs,
    advancePayments,
    leaveRequests,
    officialDocuments,
    adminDocs,
    announcements,
    chatMessages,
    chatGroups
  };

  if (hadTimeout) {
    // 캐싱하지 않음: 다음 요청에서 다시 정상적으로 조회를 시도하도록 함
    return loadedData;
  }

  db[scopeId] = loadedData;
  return db[scopeId];
}

// 서버 시작 시 1회: 로그인 계정 시딩 및 로컬 캐시 적재
async function bootstrapUsers() {
  users = await getUsers();
  // 운영 환경에서는 demo/partner 같은 기본 계정(비밀번호 공통)을 만들지 않는다.
  if (users.length === 0 && process.env.NODE_ENV !== 'production') {
    await ensureUsersSeeded(initialUsers);
    users = await getUsers();
  }
}

// HTTP 헤더(x-user-id)를 기반으로 스코프 ID를 동기적으로 계산 (DB 호출 없음, users는 메모리 캐시 사용)
function resolveScopeId(req: express.Request): string {
  const userId = req.headers['x-user-id'] as string;
  let scopeId = 'default';

  if (userId) {
    const user = users.find(u => u.id === userId);
    if (user) {
      scopeId = scopeIdForUser(user);
    }
  }
  return scopeId;
}

// Express 전용 스코프 데이터 동기 반환
// (스코프 데이터는 아래 app.use 미들웨어에서 요청 처리 전에 이미 로드가 보장됩니다)
function getScopedData(req: express.Request): ScopedData {
  const scopeId = req.scopeId || 'default';
  return db[scopeId] || {
    contacts: [],
    projects: [],
    groups: [],
    myProfile: initialMyProfile,
    vehicles: [],
    drivingLogs: [],
    expenses: [],
    maintenances: [],
    maintenanceIntervals: [],
    dailyLogs: [],
    weeklyLogs: [],
    advancePayments: [],
    leaveRequests: [],
    officialDocuments: [],
    adminDocs: [],
    announcements: [],
    chatMessages: [],
    chatGroups: []
  };
}

// ------------------------------------------------------------------
// 🚧 승인 대기 회원 접근 차단
// [추가] 같은 회사(사업자번호)로 두 번째 이후 가입한 사람은 approvalStatus가 'pending'
// 상태로 시작한다. 관리자가 승인하기 전까지는, 로그인은 할 수 있지만(그래야 "승인
// 대기중입니다" 화면을 보여줄 수 있으니) 그 외의 모든 API(명함 조회 포함)는 막는다.
// 정적 파일(SPA 프런트엔드 자체)과 최소한의 인증 관련 API는 허용 목록에 둔다.
// ------------------------------------------------------------------
const PENDING_APPROVAL_ALLOWED_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/verify-email',
  '/api/auth/email/confirm', // [추가] 새 이메일로 받은 인증 링크 (토큰으로만 본인 확인)
  '/api/auth/resend-verification',
  '/api/auth/withdraw',
  '/api/auth/lookup-company', // 회원가입 화면에서 로그인 전에도 써야 하는 유일한 공개 API
  // [수정] 아래 둘은 로그인한 "사용자"가 아니라 외부 크론 서비스가 주기적으로 호출하는
  // 엔드포인트다. 각자 CRON_SECRET 헤더로 자체적으로 보호하고 있으니(값 모르면 401),
  // 로그인 세션 요구 게이트에서는 예외로 통과시켜준다 — 안 그러면 크론이 애초에 호출을
  // 못 해서(사람이 로그인한 세션이 없으니) 아무 때도 자동으로 못 돈다.
  '/api/billing/run-scheduled',
  '/api/admin/run-company-summary-batch',
  // [추가] 애플 캘린더(아이폰/아이패드/맥) 구독 피드. 캘린더 앱은 로그인 세션 없이
  // URL 하나만 주기적으로 GET 요청하는 방식이라, x-user-id 로그인 세션 헤더를 절대
  // 보내지 않는다. 이 라우트는 URL에 담긴 무작위 토큰으로 자체적으로 사용자를 식별하고
  // 있으니(server.ts의 app.get('/api/worklogs/calendar.ics', ...) 참고), 로그인 세션
  // 요구 게이트에서는 예외로 통과시켜야 한다 — 안 그러면 항상 401(sessionExpired)로
  // 막혀서 캘린더 앱이 절대 내용을 받아올 수 없다.
  '/api/worklogs/calendar.ics'
]);

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next(); // 프런트엔드 정적 파일/라우팅은 항상 통과
  if (PENDING_APPROVAL_ALLOWED_PATHS.has(req.path)) return next();

  const userId = req.headers['x-user-id'] as string;
  const requester = userId ? users.find(u => u.id === userId) : undefined;

  // [수정] 심각한 구조적 문제를 막는다: 예전에는 로그인 세션이 없거나 만료돼도 이
  // 아래 라우트들이 그냥 통과됐고, resolveScopeId()가 조용히 "default"라는 익명
  // 공유 스코프로 처리해버렸다. 그 상태로 명함을 등록하면 "내 화면(같은 세션)"에는
  // 보이지만, 실제 내 계정 스코프에는 저장이 안 돼서 다른 기기/새로고침에서는 안
  // 보이는 문제가 있었다 — 겉으로는 "저장 성공"처럼 보여서 원인 파악이 특히 어려웠다.
  // 이제는 로그인 확인 API(/api/auth/*) 외의 모든 API는 유효한 로그인 세션이 없으면
  // 여기서 바로 401로 막는다 — "default" 스코프로 조용히 새어나가는 경로를 원천 차단.
  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다. 다시 로그인해주세요.', sessionExpired: true });
  }

  if (requester.type === 'company' && requester.approvalStatus === 'pending') {
    return res.status(403).json({
      error: '아직 회사 관리자의 승인을 받지 못했습니다. 승인 후 이용할 수 있습니다.',
      pendingApproval: true
    });
  }
  // [추가] 이메일 인증도 승인 대기와 같은 방식으로 막는다: 로그인은 되지만(그래야
  // "인증 메일을 확인해주세요" 화면을 보여줄 수 있음) 그 외 API는 다 막는다.
  if (!isEmailVerified(requester.emailVerified)) {
    return res.status(403).json({
      error: '이메일 인증이 필요합니다. 받으신 인증 메일의 링크를 눌러주세요.',
      emailVerificationRequired: true
    });
  }
  next();
});

// 🔗 스코프 해석 + Supabase 데이터 로드 미들웨어
// 이 미들웨어가 실제로 연결되어 있지 않으면 모든 요청이 빈 데이터를 보게 되므로
// (기존 AI Studio 스캐폴드에 있던 버그) 반드시 라우트 등록보다 먼저 위치해야 합니다.
app.use(async (req, res, next) => {
  try {
    const scopeId = resolveScopeId(req);
    req.scopeId = scopeId;
    await loadScopeFromSupabase(scopeId);
    next();
  } catch (error) {
    console.error('Scope resolution error:', error);
    next(error);
  }
});


// [수정] 예전엔 "강남", "판교" 같은 몇 개 동네 이름이 주소에 포함되는지만 보고 좌표를
// 대충 찍었다(그마저 안 걸리면 광화문 주변 랜덤 좌표). 그러다 보니 실제 위치와 무관한
// 좌표가 찍혀서, "주변 레이더 지도"에서 진짜 가까운 사람도 안 보이는 문제가 있었다.
// 이제는 카카오 로컬 API(주소 검색)로 실제 주소를 진짜 좌표로 변환한다. 정확한 주소로
// 못 찾으면, 조금 더 너그러운 "키워드 검색"으로 한 번 더 시도한다. 그래도 못 찾으면
// 억지로 아무 좌표나 채우지 않고 undefined로 둔다 — 틀린 좌표를 보여주는 것보다,
// "이 명함은 아직 위치 정보가 없다"고 정직하게 비워두는 게 낫다.
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const result = await geocodeAddressWithDiagnostics(address);
  return result.coords;
}

// [추가] 재계산 버튼을 눌렀는데 전부 실패하는 경우, 서버 로그를 따로 안 봐도 화면에서
// 바로 원인을 알 수 있도록 실패 사유를 같이 돌려준다 (예: 키 미설정, 401 인증 오류 등).
async function geocodeAddressWithDiagnostics(address: string): Promise<{ coords: { lat: number; lng: number } | null; error?: string }> {
  // [수정] 카카오 로컬 API는 검색어(query)를 100자까지만 받는다({"code":-2,"msg":"Max
  // (query) length 100"}). 이보다 긴 주소(상세 동/호수, 건물명까지 다 붙어서 100자를
  // 넘는 경우)를 그대로 보내면 무조건 400 에러가 났다. 한국 주소는 보통 "시/도 → 구 →
  // 동 → 번지" 순으로, 위치를 특정하는 데 중요한 정보가 앞쪽에 있으므로, 100자를
  // 넘으면 앞부분만 잘라서 보낸다(뒤쪽 상세 동/호수 정보는 위치 계산엔 크게 중요하지
  // 않다).
  let cleaned = (address || '').trim();
  // [추가] "521\, Teheran-ro\, ..."처럼, vCard 가져오기 과정에서 이스케이프 문자(백슬래시)가
  // 안 지워진 채로 이미 저장된 기존 주소들이 있었다. (원인 자체는 IOModal.tsx의 vCard
  // 파싱 로직에서 고쳤지만, 이미 저장된 데이터에는 소급 적용이 안 되므로 여기서도 한 번
  // 더 정리해서 기존 주소도 검색이 되게 한다.) "\n"(줄바꿈 이스케이프)도 같은 문제였는데
  // 처음엔 놓쳤다가, 실제 사례("...23\n서울특별시...")를 보고 추가했다.
  cleaned = cleaned.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ');
  // [수정] 우편번호나 "대한민국" 같은 국가명이 주소 맨 끝뿐 아니라 문장 중간에도 끼어있는
  // 경우가 실제로 있었다(예: "...4층), 05630 서울시   대한민국" — 우편번호 뒤에 시/도명과
  // 국가명이 또 붙는 뒤죽박죽 형태). 명함 OCR이나 다른 시스템에서 복사해올 때 생기는 흔한
  // 오염 패턴이라, 위치에 상관없이 이런 조각들을 다 제거하고 검색한다.
  cleaned = cleaned
    // [수정] "한국"만 있는 짧은 표기도 국가명으로 추가 인식(단, "한국00빌딩"처럼 다른 단어의
    // 일부로 쓰인 경우까지 잘못 지우지 않도록 앞뒤가 공백/문장경계일 때만 매치되게 한다).
    .replace(/대한민국|South\s*Korea|Republic\s*of\s*Korea|(?<![가-힣])한국(?![가-힣])/gi, ' ')
    .replace(/,?\s*\b\d{5}\b/g, ' ') // 신규 우편번호(5자리 숫자)
    .replace(/,?\s*\b\d{3}-\d{3}\b/g, ' ') // 구 우편번호(123-456 형식)
    .replace(/\s{2,}/g, ' ') // 여러 조각을 지우고 남은 중복 공백 정리
    .replace(/,\s*,/g, ',') // 쉼표가 연달아 남은 경우 정리
    .replace(/,\s*$/, '') // 맨 끝에 쉼표만 남은 경우 제거
    .trim();

  // [추가] "용산구 용산동 용산고길 23 서울특별시"처럼, 시/도 이름이 맨 앞이 아니라
  // 뒤쪽(심지어 맨 끝)에 붙어있는 주소가 실제로 많았다. 한국 주소는 "시/도 → 구 → 동 →
  // 도로명" 순서로 맨 앞에 시/도가 와야 카카오가 정확히 인식하므로, 시/도 이름이 뒤에
  // 있으면 찾아서 맨 앞으로 옮겨준다.
  const PROVINCE_NAMES = [
    '서울특별시', '서울시', '서울', '부산광역시', '부산시', '부산', '대구광역시', '대구시', '대구',
    '인천광역시', '인천시', '인천', '광주광역시', '광주시', '광주', '대전광역시', '대전시', '대전',
    '울산광역시', '울산시', '울산', '세종특별자치시', '세종시', '세종', '경기도', '경기',
    '강원특별자치도', '강원도', '강원', '충청북도', '충북', '충청남도', '충남',
    '전북특별자치도', '전라북도', '전북', '전라남도', '전남', '경상북도', '경북', '경상남도', '경남',
    '제주특별자치도', '제주도', '제주'
  ];
  for (const province of PROVINCE_NAMES) {
    const idx = cleaned.indexOf(province);
    // 이미 맨 앞(0~2번째 글자 이내)에 있으면 그대로 두고, 뒤쪽에 있을 때만 앞으로 옮긴다.
    if (idx > 2) {
      cleaned = `${province} ${cleaned.slice(0, idx)}${cleaned.slice(idx + province.length)}`.replace(/\s{2,}/g, ' ').trim();
      break;
    }
  }

  const trimmed = cleaned.slice(0, 100);
  if (!trimmed) return { coords: null, error: '주소가 비어있음' };
  if (!KAKAO_REST_API_KEY) {
    return { coords: null, error: 'KAKAO_REST_API_KEY 환경변수가 설정되지 않음' };
  }

  const headers = { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` };
  try {
    const addrRes = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(trimmed)}`, { headers });
    if (addrRes.ok) {
      const addrData: KakaoLocalResponse = await addrRes.json();
      const doc = addrData?.documents?.[0];
      if (doc) return { coords: { lat: parseFloat(doc.y), lng: parseFloat(doc.x) } };
    } else {
      const bodyText = await addrRes.text().catch(() => '');
      console.error(`카카오 주소 검색 API 오류 (상태 ${addrRes.status}, 주소: "${trimmed}"):`, bodyText.slice(0, 300));
      // 401/403이면 키 자체가 잘못됐거나 활성화가 안 된 것 -> 두 번째(키워드) 시도도
      // 똑같이 실패할 게 뻔하니, 바로 원인을 리턴해서 헛수고를 줄인다.
      if (addrRes.status === 401 || addrRes.status === 403) {
        return { coords: null, error: `카카오 API 인증 실패 (상태 ${addrRes.status}) - REST API 키가 잘못됐거나, 로컬 API 사용 설정이 안 돼있을 수 있습니다.` };
      }
      // [수정] 상태 코드만으로는 원인을 알 수 없어서(예: 400은 "잘못된 요청"이라는 뜻일
      // 뿐, 정확히 뭐가 문제인지는 카카오가 돌려주는 본문 메시지를 봐야 안다), 실제 에러
      // 본문을 화면까지 그대로 노출한다.
      if (addrRes.status === 400) {
        return { coords: null, error: `카카오 API 400 오류 (주소: "${trimmed.slice(0, 40)}") - ${bodyText.slice(0, 200)}` };
      }
    }

    const keywordRes = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(trimmed)}`, { headers });
    if (keywordRes.ok) {
      const keywordData: KakaoLocalResponse = await keywordRes.json();
      const doc = keywordData?.documents?.[0];
      if (doc) return { coords: { lat: parseFloat(doc.y), lng: parseFloat(doc.x) } };

      // [수정] 티맵/카카오내비 등 지도 앱은 사람이 결과를 눈으로 보면서 "이 정도면 됐다"고
      // 판단하는 여유가 있어서, 주소가 살짝 부정확해도 그럴듯한 후보를 잘 찾아준다. 반면
      // 우리는 사람 확인 없이 자동으로 정확히 하나를 찾아야 해서 훨씬 엄격했다. 이 격차를
      // 좁히기 위해, 검색이 실패하면 사람이 검색창에서 뒷부분을 하나씩 지워가며 다시
      // 시도하는 것처럼, 주소를 점점 단순하게 줄여가며 재시도한다.
      const candidateQueries: string[] = [];

      // 1단계: 괄호 안 설명(동명 등)과 "9층" 이후(건물명/층수)를 뗀 핵심 도로명 주소
      const coreAddress = trimmed
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\d+\s*층.*$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (coreAddress && coreAddress !== trimmed && coreAddress.length >= 4) {
        candidateQueries.push(coreAddress);
      }

      // 2단계: 그래도 안 되면, 뒤에서부터 단어를 하나씩 지워가며 점점 짧게 만든다
      // (예: "용산구 용산동 용산고길 23 반도 유스퀘어" -> "...용산고길 23 반도" -> "...용산고길 23"
      // -> "...용산고길" -> "용산구 용산동" 순으로 점점 범위를 넓혀가며 재시도).
      // 시/도 + 구/군 정도(최소 2단어)까지만 줄이고 그 이하로는 너무 부정확해지므로 멈춘다.
      const base = coreAddress || trimmed;
      const tokens = base.split(' ').filter(Boolean);
      for (let cut = tokens.length - 1; cut >= 2; cut--) {
        const candidate = tokens.slice(0, cut).join(' ');
        if (candidate.length >= 4 && !candidateQueries.includes(candidate)) {
          candidateQueries.push(candidate);
        }
      }

      for (const candidate of candidateQueries) {
        try {
          const candRes = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(candidate)}`, { headers });
          if (candRes.ok) {
            const candData: KakaoLocalResponse = await candRes.json();
            const candDoc = candData?.documents?.[0];
            if (candDoc) return { coords: { lat: parseFloat(candDoc.y), lng: parseFloat(candDoc.x) } };
          }
        } catch {
          // 이 후보 하나가 네트워크 오류로 실패해도, 다음 후보(더 단순한 주소)로 계속 시도한다.
        }
      }

      // [수정] "검색 결과 없음"이라고만 하면, 우리 쪽 정리 로직(백슬래시 제거, 시/도 재배치
      // 등)이 실제로 뭘로 바꿔서 보냈는지 알 수가 없어서, 그 정리 로직 자체가 제대로
      // 작동하는지 확인할 방법이 없었다. 실제로 카카오에 보낸 검색어를 메시지에 그대로
      // 넣어서, "정리는 됐는데 그래도 못 찾는 건지" "정리 자체가 안 된 건지"를 바로
      // 눈으로 구분할 수 있게 한다.
      return { coords: null, error: `주소/키워드 검색 결과 없음 (실제 보낸 검색어: "${trimmed}")` };
    } else {
      const bodyText = await keywordRes.text().catch(() => '');
      console.error(`카카오 키워드 검색 API 오류 (상태 ${keywordRes.status}, 주소: "${trimmed}"):`, bodyText.slice(0, 300));
      return { coords: null, error: `카카오 API 오류 (상태 ${keywordRes.status}) - ${bodyText.slice(0, 200)}` };
    }
  } catch (err: unknown) {
    console.error('주소 지오코딩 중 오류:', err);
    // 실제 예외 메시지(err.message)는 케이스마다 제각각이라 문자열로 정확히 판별하기
    // 어려우니, 재시도 판별에 안정적으로 쓸 수 있게 항상 같은 문구로 통일해서 돌려준다.
    // 원본 메시지는 서버 로그에 이미 남겨뒀다.
    return { coords: null, error: `네트워크 오류: ${getErrorMessage(err) || '알 수 없음'}` };
  }
}


// API Routes

// [수정] frontImage/backImage 같은 사진 필드가 base64 데이터(용량이 큼)로 들어오면
// Supabase Storage에 실제 파일로 올리고, DB에는 그 파일 주소(URL)만 저장한다.
// 이미 URL이거나(재사용) 값이 없으면 그대로 둔다. 업로드가 실패해도 예전처럼
// base64를 그대로 저장해서(안전장치) 최소한 사진 자체는 안 깨지게 한다.
async function persistImageField(
  scopeId: string,
  value: string | undefined,
  keyHint: string,
  category: 'cards' | 'receipts' | 'signatures' | 'branding' = 'cards'
): Promise<string | undefined> {
  if (!value || !value.startsWith('data:image/')) return value;
  try {
    const url = await uploadDataUrlImage(scopeId, value, keyHint, category);
    return url || value;
  } catch (err) {
    console.error(`persistImageField(${keyHint}) 실패, base64를 그대로 저장합니다:`, err);
    return value;
  }
}

// [수정] 미팅 지출/업무일지 지출처럼 "배열 안에 여러 영수증 사진"이 들어있는 경우,
// 항목 하나하나(receiptImage)를 각각 Storage의 receipts 폴더에 업로드하고 URL로 교체한다.
async function persistReceiptImagesInArray<T extends { id: string; receiptImage?: string }>(
  scopeId: string,
  items: T[] | undefined,
  keyPrefix: string
): Promise<T[] | undefined> {
  if (!items || !items.length) return items;
  return Promise.all(items.map(async (item) => ({
    ...item,
    receiptImage: await persistImageField(scopeId, item.receiptImage, `${keyPrefix}-${item.id}`, 'receipts')
  })));
}

// [추가] 자동차 등록증처럼 "사진일 수도, PDF일 수도 있는" 파일 하나짜리 필드를 위한 범용
// 버전. persistImageField는 image/*만 처리하는데, 등록증은 사진으로 찍을 수도 있고
// PDF 파일을 올릴 수도 있어서 uploadDataUrlFile(범용 MIME 지원)을 대신 쓴다. 이미 URL이거나
// 값이 없으면 그대로 두고, 업로드 실패 시에도 base64를 그대로 저장해 사진/파일 자체는
// 안 깨지게 한다(다른 persist* 헬퍼들과 동일한 안전장치).
async function persistFileField(
  scopeId: string,
  value: string | undefined,
  keyHint: string,
  category: 'cards' | 'receipts' | 'attachments' = 'attachments'
): Promise<string | undefined> {
  if (!value || !value.startsWith('data:')) return value;
  try {
    const url = await uploadDataUrlFile(scopeId, value, keyHint, category);
    return url || value;
  } catch (err) {
    console.error(`persistFileField(${keyHint}) 실패, base64를 그대로 저장합니다:`, err);
    return value;
  }
}

// [추가] 미팅 첨부파일(제안서/견적서/발송자료 등, PDF·PPT·엑셀·한글 다 포함)을 그대로 base64로
// DB에 쌓아두면, 문서 몇 개만 있어도 프로젝트 하나의 JSON이 수십MB로 불어나서 저장/전송이
// 느려지거나 실패하기 쉽다(특히 모바일 네트워크에서). 영수증 사진처럼 Storage에 실제 파일로
// 올리고 URL만 남긴다. 업로드가 실패해도(설정 안 됐거나 오류) base64를 그대로 저장해서
// 최소한 첨부파일 자체는 안 깨지게 한다.
async function persistAttachmentsInArray(
  scopeId: string,
  attachments: { id: string; name: string; dataUrl: string; size?: number }[] | undefined,
  keyPrefix: string
): Promise<typeof attachments> {
  if (!attachments || !attachments.length) return attachments;
  return Promise.all(attachments.map(async (att) => {
    if (!att.dataUrl || !att.dataUrl.startsWith('data:')) return att; // 이미 URL이면(재수정 시) 그대로 둠
    try {
      const url = await uploadDataUrlFile(scopeId, att.dataUrl, `${keyPrefix}-${att.id}`, 'attachments', att.name);
      return url ? { ...att, dataUrl: url } : att;
    } catch (err) {
      console.error(`persistAttachmentsInArray(${keyPrefix}-${att.id}) 실패, base64를 그대로 저장합니다:`, err);
      return att;
    }
  }));
}

// [추가] 사진/파일(스캔·촬영 등)이 포함된 저장 요청에서 반복되는 패턴을 하나로 묶은 헬퍼.
// setScopedDoc/setScopedDocs가 DB 저장 실패 시 서버 콘솔에만 로그를 남기고 조용히 "성공"을
// 반환하던 문제를 고쳐서 이제 boolean을 돌려주는데, 이 boolean을 매 라우트마다 일일이
// 확인하고 "메모리 캐시 롤백 + 에러 응답"을 반복해서 쓰면 실수하기 쉽다. 이 헬퍼를 쓰면
// 저장이 실패했을 때 rollback()으로 메모리를 되돌리고, 지정한 메시지로 500 에러 응답까지
// 한 번에 처리해준다. 호출부는 반환값이 false면 곧바로 return하면 된다(이미 응답을 보냈으므로).
async function persistOrRespondError(
  res: express.Response,
  saveFn: () => Promise<boolean>,
  rollback: () => void,
  errorMessage: string
): Promise<boolean> {
  const saved = await saveFn();
  if (!saved) {
    rollback();
    res.status(500).json({ error: errorMessage });
    return false;
  }
  return true;
}

// 비밀번호 검증: bcrypt 해시면 정식 비교, 옛날 평문으로 저장된 계정이면 평문 비교 후
// 성공 시 자동으로 안전한 해시로 업그레이드합니다 (기존 가입자 로그인이 끊기지 않도록).
function verifyPassword(inputPassword: string, storedPassword?: string): boolean {
  if (!storedPassword) return false;
  if (storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2y$')) {
    return bcrypt.compareSync(inputPassword, storedPassword);
  }
  return inputPassword === storedPassword; // 레거시 평문 비밀번호 호환
}

// ------------------------------------------------------------------
// 🛡️ 로그인 무차별 대입(brute-force) 방어 + 회원가입 스팸 방지
// [수정] 레이트리밋 구현 자체는 src/rateLimiter.ts로 옮겨서 단위 테스트를 붙였다.
// "이메일+IP" 조합으로 짧은 시간에 로그인 실패가 반복되면 잠시 잠근다 (계정 자체가 아니라
// 조합 단위로 제한해서, 한 사람이 다른 사람 계정에 무제한 시도하는 것도 같이 막는다).
// ------------------------------------------------------------------
const loginRateLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 10 * 60 * 1000, lockoutMs: 10 * 60 * 1000 });

// [추가] 회원가입 API도 무제한으로 열려있으면 스팸 계정을 자동으로 대량 생성할 수 있다.
// IP 기준으로 1시간에 5회까지만 허용한다 (같은 사무실에서 여러 직원이 잇달아 가입하는
// 정상적인 경우도 있어서, 로그인 제한보다는 넉넉하게 잡았다).
const signupRateLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000 });

// [추가] 회원가입 화면에서 사업자등록번호를 입력하면, 이미 그 번호로 등록된 회사가 있는지
// 미리 알려주는 API. 있으면 그 회사가 쓰던 정확한 회사명을 돌려줘서 자동으로 채워준다 —
// "주식회사 OO"과 "(주)OO"처럼 표기가 갈려서 같은 회사인데 다른 회사로 인식되던 문제를
// 가입 시점에 원천적으로 막기 위함이다. 로그인 전에도 써야 하니 인증 없이 열어두되,
// 사업자번호를 마구 훑어보는(enumeration) 걸 막기 위해 IP당 시간당 30회로 제한한다.
const companyLookupRateLimiter = new RateLimiter({ maxAttempts: 30, windowMs: 60 * 60 * 1000 });

// [추가] 명함/영수증 스캔은 Gemini API를 호출하는데, 이건 호출할 때마다 실제 비용이
// 든다. 버그로 인한 무한 반복 호출이나 남용을 막기 위해, 로그인 계정당 10분에 100회
// (전시회/네트워킹 행사에서 명함을 수십 장 연속 촬영하는 정상적인 사용은 충분히
// 허용하면서, 비정상적인 폭주만 막는 수준)로 제한한다.
const aiScanRateLimiter = new RateLimiter({ maxAttempts: 100, windowMs: 10 * 60 * 1000 });

// [추가] 데이터 수정(PUT/DELETE) API Rate Limiting
// 계정당 1분에 30회로 제한 (정상 사용 충분히 허용, 비정상 폭주만 방어)
const dataModifyRateLimiter = new RateLimiter({ maxAttempts: 30, windowMs: 60 * 1000 });

// [추가] 데이터 수정 API Rate Limiting 체크 헬퍼
function checkModifyRateLimit(req: express.Request, res: express.Response): boolean {
  const userId = req.headers['x-user-id'] as string;
  const limitCheck = dataModifyRateLimiter.check(userId);
  if (!limitCheck.allowed) {
    res.status(429).json({ error: `요청이 너무 많습니다. ${limitCheck.retryAfterSec}초 후 다시 시도해주세요.` });
    return false;
  }
  dataModifyRateLimiter.registerAttempt(userId);
  return true;
}

app.get('/api/auth/lookup-company', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const limit = companyLookupRateLimiter.check(ip);
  companyLookupRateLimiter.registerAttempt(ip);
  if (!limit.allowed) {
    return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }

  const businessNumber = String(req.query.businessNumber || '').trim();
  if (!businessNumber) return res.json({ found: false });

  const existing = users.find(u => u.type === 'company' && (u.businessNumber || '').trim() === businessNumber);
  if (!existing) return res.json({ found: false });

  // 이메일/이름 등 개인정보는 노출하지 않고, 회사명만 알려준다.
  res.json({ found: true, companyName: existing.companyName || '' });
});

// ------------------------------------------------------------------
// 🎁 친구 추천 프로그램
// 기존 고객(추천인)이 자기 추천 코드/링크를 공유해서 새 고객(피추천인)을 데려오면,
// 피추천인이 "실제로 첫 구독 결제를 완료했을 때" 양쪽 모두에게 무료 1개월을 준다.
// 가입만 하고 결제는 안 하는 가짜 계정으로 반복 악용하는 걸 막기 위해, 보상 지급
// 시점을 가입이 아니라 결제 성공 시점으로 잡았다 (아래 /api/billing/subscribe 참고).
// ------------------------------------------------------------------
function generateReferralCode(): string {
  // 혼동되기 쉬운 문자(0/O, 1/I/L)는 빼고, 사람이 직접 읽어서 입력해도 헷갈리지 않게 한다.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// 이 사용자의 추천 코드를 조회하고, 없으면 만들어서 저장한다 (최초 조회 시점에 지연 생성).
async function getOrCreateReferralCode(user: RegisteredUser): Promise<string> {
  if (user.referralCode) return user.referralCode;
  let code = generateReferralCode();
  // 극히 낮은 확률의 충돌이라도 피하기 위해 중복이면 다시 생성한다.
  while (users.some(u => u.referralCode === code)) {
    code = generateReferralCode();
  }
  user.referralCode = code;
  await addUser(user);
  return code;
}

// 무료 개월 보상을 실제로 반영한다. 이미 이번 달 구독료를 내고 있는 중(active)이면 다음
// 결제일을 그만큼 밀어서 즉시 체감되게 하고, 아직 구독 전(free)이거나 해지한 상태라면
// 나중에 구독을 시작할 때 한꺼번에 반영하도록 크레딧으로 쌓아둔다.
async function applyReferralCreditMonths(user: RegisteredUser, months: number): Promise<void> {
  if (months <= 0) return;
  if (user.subscriptionStatus === 'active' && user.nextBillingAt) {
    let next = new Date(user.nextBillingAt);
    for (let i = 0; i < months; i++) next = addOneMonth(next);
    user.nextBillingAt = next.toISOString();
  } else {
    user.referralCreditMonths = (user.referralCreditMonths || 0) + months;
  }
  await addUser(user);
}

// 내 추천 코드/링크와 현재까지의 추천 현황(몇 명 추천했고, 몇 명에게 보상이 지급됐는지) 조회.
app.get('/api/referral/me', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const code = await getOrCreateReferralCode(requester);
  const referrals = await getReferralsForUser(requester.id);
  res.json({
    referralCode: code,
    shareUrl: `${APP_BASE_URL}/?ref=${code}`,
    totalReferred: referrals.length,
    totalRewarded: referrals.filter((r) => r.status === 'rewarded').length,
    pendingCreditMonths: requester.referralCreditMonths || 0,
    referrals: referrals.map((r) => ({
      refereeName: r.referee_name,
      refereeEmail: r.referee_email,
      status: r.status,
      createdAt: r.created_at,
      rewardedAt: r.rewarded_at
    }))
  });
});

// ------------------------------------------------------------------
// 📢 사내 공지사항 / 게시판
// 회사(스코프) 전체가 읽을 수 있고, 관리자만 작성/수정/삭제할 수 있다. 이미 있던
// admin-docs 등 다른 스코프 컬렉션과 동일하게, 메모리 캐시(db[scopeId])와 Supabase를
// 함께 갱신하는 setScopedDoc/deleteScopedDoc 패턴을 그대로 따른다.
// ------------------------------------------------------------------
app.get('/api/announcements', (req, res) => {
  const dbData = getScopedData(req);
  const list: Announcement[] = dbData.announcements || [];
  // 고정(pinned) 공지를 맨 위에, 그 안에서는 최신순으로 정렬.
  const sorted = [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  res.json(sorted);
});

app.post('/api/announcements', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const scopeId = req.scopeId;
  const dbData = getScopedData(req);

  const { title, content, pinned } = req.body;
  if (!title || !String(title).trim() || !content || !String(content).trim()) {
    return res.status(400).json({ error: '제목과 내용을 모두 입력해주세요.' });
  }

  const now = new Date().toISOString();
  const announcement: Announcement = {
    id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scopeId,
    authorUserId: requester.id,
    authorName: requester.name,
    title: String(title).trim(),
    content: String(content).trim(),
    pinned: Boolean(pinned),
    createdAt: now,
    updatedAt: now
  };

  dbData.announcements = dbData.announcements || [];
  dbData.announcements.unshift(announcement);
  const saved = await setScopedDoc(scopeId, 'announcements', announcement);
  if (!saved) {
    dbData.announcements = dbData.announcements.filter((a: Announcement) => a.id !== announcement.id);
    return res.status(500).json({ error: '공지사항을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(announcement);
});

app.put('/api/announcements/:id', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const scopeId = req.scopeId;
  const dbData = getScopedData(req);
  dbData.announcements = dbData.announcements || [];
  const idx = dbData.announcements.findIndex((a: Announcement) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '공지사항을 찾을 수 없습니다.' });

  const previous = dbData.announcements[idx];
  const { title, content, pinned } = req.body;
  const updated: Announcement = {
    ...previous,
    title: typeof title === 'string' && title.trim() ? title.trim() : previous.title,
    content: typeof content === 'string' && content.trim() ? content.trim() : previous.content,
    pinned: typeof pinned === 'boolean' ? pinned : previous.pinned,
    updatedAt: new Date().toISOString()
  };
  dbData.announcements[idx] = updated;
  const saved = await setScopedDoc(scopeId, 'announcements', updated);
  if (!saved) {
    dbData.announcements[idx] = previous;
    return res.status(500).json({ error: '공지사항 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(updated);
});

app.delete('/api/announcements/:id', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const scopeId = req.scopeId;
  const dbData = getScopedData(req);
  dbData.announcements = dbData.announcements || [];
  dbData.announcements = dbData.announcements.filter((a: Announcement) => a.id !== req.params.id);
  await deleteScopedDoc(scopeId, 'announcements', req.params.id);
  res.json({ success: true });
});

// ------------------------------------------------------------------
// 💬 사내 메신저 (폴링 방식)
// 무료 배포 환경에 웹소켓 서버를 새로 두지 않고, 클라이언트가 몇 초 간격으로
// "마지막으로 받은 메시지 이후"를 조회하는 방식으로 구현했다. 채널은 "team"(회사 전체
// 채널) 또는 "dm:<정렬된 두 사용자 id>"(1:1 대화) 형태다.
// ------------------------------------------------------------------
function dmChannelId(userIdA: string, userIdB: string): string {
  return `dm:${[userIdA, userIdB].sort().join(':')}`;
}

// group: 채널은 채널명(그룹 id)만으로는 누가 멤버인지 알 수 없으므로, 그때그때
// chatGroups에서 실제 멤버 목록을 찾아 확인한다. 그룹 자체가 없으면(삭제됐거나
// 잘못된 id) 접근을 막는다.
function canAccessGroupChannel(requester: { chatGroups?: ChatGroup[] }, channel: string, requesterId: string): boolean {
  const groupId = channel.slice('group:'.length);
  const group = (requester.chatGroups || []).find((g: ChatGroup) => g.id === groupId);
  return Boolean(group && group.memberUserIds.includes(requesterId));
}

app.get('/api/chat/messages', (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const channel = String(req.query.channel || 'team');
  // 1:1 대화방(dm:a:b)은 그 두 사람만, 소그룹 대화방(group:id)은 멤버로 지정된
  // 사람만 조회할 수 있게 막는다 — 안 그러면 채널 이름만 알면 남의 대화를 그대로
  // 읽을 수 있는 문제가 생긴다.
  if (channel.startsWith('dm:')) {
    const parts = channel.slice(3).split(':');
    if (!parts.includes(requester.id)) {
      return res.status(403).json({ error: '이 대화를 조회할 권한이 없습니다.' });
    }
  } else if (channel.startsWith('group:')) {
    const dbData = getScopedData(req);
    if (!canAccessGroupChannel(dbData, channel, requester.id)) {
      return res.status(403).json({ error: '이 그룹 대화를 조회할 권한이 없습니다.' });
    }
  }

  const dbData = getScopedData(req);
  const all: ChatMessage[] = (dbData.chatMessages || []);
  const since = req.query.sinceId ? String(req.query.sinceId) : undefined;
  let list = all.filter((m) => m.channel === channel);
  if (since) {
    const sinceIdx = list.findIndex((m) => m.id === since);
    if (sinceIdx !== -1) list = list.slice(sinceIdx + 1);
  } else {
    // 최초 로딩 시에는 최근 50건만 내려준다 (대화가 길어져도 매번 전체를 안 보내도록).
    list = list.slice(-50);
  }
  res.json(list);
});

app.post('/api/chat/messages', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const channel = String(req.body.channel || 'team');
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '내용을 입력해주세요.' });
  if (content.length > 2000) return res.status(400).json({ error: '메시지가 너무 깁니다 (최대 2000자).' });
  const scopeId = req.scopeId;
  const dbData = getScopedData(req);
  if (channel.startsWith('dm:')) {
    const parts = channel.slice(3).split(':');
    if (!parts.includes(requester.id)) {
      return res.status(403).json({ error: '이 대화에 보낼 권한이 없습니다.' });
    }
  } else if (channel.startsWith('group:') && !canAccessGroupChannel(dbData, channel, requester.id)) {
    return res.status(403).json({ error: '이 그룹 대화에 보낼 권한이 없습니다.' });
  }

  const message: ChatMessage = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scopeId,
    channel,
    senderUserId: requester.id,
    senderName: requester.name,
    content,
    createdAt: new Date().toISOString()
  };
  dbData.chatMessages = dbData.chatMessages || [];
  dbData.chatMessages.push(message);
  const saved = await setScopedDoc(scopeId, 'chatMessages', message);
  if (!saved) {
    dbData.chatMessages = dbData.chatMessages.filter((m: ChatMessage) => m.id !== message.id);
    return res.status(500).json({ error: '메시지를 전송하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(message);
});

// [추가] 소그룹(부서/프로젝트 단위 등, 2명 이상 지정) 채팅방. 팀 전체 채널과 1:1 대화만
// 있던 걸 보완한다 — 사내 메신저는 결국 "이 프로젝트 관련된 3명끼리만" 같은 대화가
// 훨씬 많다는 요청에 따라 추가했다.
app.get('/api/chat/groups', (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const dbData = getScopedData(req);
  const groups: ChatGroup[] = (dbData.chatGroups || []);
  const myGroups = groups.filter((g) => g.memberUserIds.includes(requester.id));
  res.json(myGroups);
});

app.post('/api/chat/groups', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const name = String(req.body.name || '').trim();
  const memberUserIds: string[] = Array.isArray(req.body.memberUserIds) ? req.body.memberUserIds : [];
  if (!name) return res.status(400).json({ error: '그룹 이름을 입력해주세요.' });

  // 만든 사람은 항상 포함시키고, 중복은 제거한다. 본인 외 최소 1명은 있어야 대화가 된다
  // (본인 외 1명이면 사실상 1:1 대화방과 같지만, 이름을 붙여 구분하고 싶을 수 있으니
  // 굳이 막지 않는다).
  const scopeId = req.scopeId;
  const uniqueMemberIds = Array.from(new Set([requester.id, ...memberUserIds]));
  if (uniqueMemberIds.length < 2) {
    return res.status(400).json({ error: '본인 외에 1명 이상을 선택해주세요.' });
  }
  // 같은 회사(스코프) 소속이 맞는지 검증한다 — 안 그러면 다른 회사 사람을 id만 알아서
  // 그룹에 끼워 넣고 대화를 훔쳐볼 수 있는 문제가 생긴다.
  const invalidMember = uniqueMemberIds.find((id) => {
    const u = users.find((cand) => cand.id === id);
    return !u || scopeIdForUser(u) !== scopeId;
  });
  if (invalidMember) {
    return res.status(400).json({ error: '같은 회사 소속 동료만 그룹에 초대할 수 있습니다.' });
  }

  const dbData = getScopedData(req);
  const group: ChatGroup = {
    id: `chatgroup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scopeId,
    name,
    memberUserIds: uniqueMemberIds,
    createdByUserId: requester.id,
    createdAt: new Date().toISOString()
  };
  dbData.chatGroups = dbData.chatGroups || [];
  dbData.chatGroups.push(group);
  const saved = await setScopedDoc(scopeId, 'chatGroups', group);
  if (!saved) {
    dbData.chatGroups = dbData.chatGroups.filter((g: ChatGroup) => g.id !== group.id);
    return res.status(500).json({ error: '그룹을 만들지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(group);
});

// 🔐 Auth APIs

/**
 * @swagger
 * /api/auth/signup:
 *   post:
 *     summary: 사용자 회원가입
 *     description: 새로운 사용자 계정을 생성합니다
 *     tags:
 *       - Authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - name
 *               - type
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 description: 8자 이상, 숫자 1개, 특수문자(!@#$%^&*_-=+) 1개 포함
 *               name:
 *                 type: string
 *               phone:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [individual, business]
 *     responses:
 *       201:
 *         description: 회원가입 성공
 *       400:
 *         description: 유효성 검증 실패
 */
app.post('/api/auth/signup', async (req, res) => {
  const signupIp = req.ip || req.socket.remoteAddress || 'unknown';
  const signupLimit = signupRateLimiter.check(signupIp);
  signupRateLimiter.registerAttempt(signupIp);
  if (!signupLimit.allowed) {
    return res.status(429).json({ error: `가입 시도가 너무 많습니다. ${signupLimit.retryAfterSec}초 후 다시 시도해주세요.` });
  }

  const { email, password, name, phone, type, companyName, businessNumber, position, referralCode } = req.body;
  if (!email || !password || !name || !type) {
    return res.status(400).json({ error: '필수 가입 정보가 누락되었습니다.' });
  }

  // [수정] 이메일 입력값 검증: 기본 형식만 검증 (Supabase가 SQL 주입 방어)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const normalizedEmail = email.toLowerCase().trim();
  if (!emailRegex.test(normalizedEmail)) {
    return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다.' });
  }

  // [수정] 이름: 필수 입력만 확인 (내용은 자유)
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: '이름을 입력해주세요.' });
  }

  // [수정] 전화번호: 입력된 경우만 확인 (내용은 자유)
  if (phone && typeof phone !== 'string') {
    return res.status(400).json({ error: '전화번호 형식이 잘못되었습니다.' });
  }

  // [수정] 회사명: 입력된 경우만 확인 (내용은 자유)
  if (companyName && typeof companyName !== 'string') {
    return res.status(400).json({ error: '회사명 형식이 잘못되었습니다.' });
  }

  // [추가] 비밀번호 복잡도 검증 (최소 8자 + 숫자 1개 + 특수문자 1개)
  const passwordValidation = validatePasswordComplexity(password);
  if (!passwordValidation.valid) {
    return res.status(400).json({ error: passwordValidation.error });
  }

  // 메모리 캐시(users)로 1차 확인 + Supabase에서 직접 한 번 더 재확인(캐시가 오래됐을 가능성에 대비한 안전장치).
  // 이 두 단계 확인으로, 같은 이메일로 두 계정(예: 개인+사업자)이 동시에 만들어지는 문제를 막는다.
  let existing = users.find(u => u.email.toLowerCase() === normalizedEmail);
  if (!existing && process.env.DATABASE_URL) {
    const freshUsers = await getUsers();
    existing = freshUsers.find(u => u.email.toLowerCase() === normalizedEmail);
    if (existing) users = freshUsers; // 캐시가 오래되어 있었다면 이 기회에 최신 상태로 갱신
  }
  if (existing) {
    return res.status(400).json({ error: '이미 가입에 사용된 이메일입니다. 개인/사업자 계정 모두 같은 이메일로는 중복 가입할 수 없으니, 다른 이메일로 가입해주세요.' });
  }

  // [수정] role은 이제 클라이언트가 보낸 값(requestedRole)을 절대 신뢰하지 않고 서버가
  // 전적으로 계산한다. 예전에는 요청 본문에 role: 'admin'을 그냥 넣어 보내면 그대로
  // admin으로 가입시켜버려서, 회사의 사업자등록번호만 알면 누구나 curl로 그 회사의
  // 관리자 권한을 즉시 획득할 수 있는 심각한 취약점이 있었다.
  //
  // [추가] 같은 회사(회사명+사업자번호)에 이미 사람이 있으면, 이번 가입자는 "승인 대기"
  // 상태로 시작한다. 그 회사 관리자가 승인해야 실제로 명함/프로젝트 등 회사 데이터에
  // 접근할 수 있다 — 이것도 사업자번호를 아는 사람이면 누구나 즉시 회사 데이터를 볼 수
  // 있었던 문제를 막기 위함이다. 그 회사의 최초 가입자는 관리자로서 바로 승인된 상태로 시작한다.
  // [수정] 예전엔 "회사명 + 사업자번호"가 둘 다 똑같아야 "같은 회사"로 인식했는데, 실제
  // 데이터 공유 범위(scopeIdForUser)는 사업자번호"만"으로 정해진다. 그래서 같은 회사인데
  // "주식회사 OO" vs "(주)OO"처럼 표기만 달라도 서로 다른 회사로 인식돼서, 각자 "최초
  // 가입자(관리자)"가 되어버리는 문제가 있었다 — 실제로는 같은 스코프를 쓰는데도 회원
  // 디렉토리에는 따로따로 표시되는 버그로 이어졌다. 이제는 사업자번호만으로 판단하고,
  // 이미 등록된 회사가 있으면 그 회사가 쓰던 회사명으로 강제 통일한다(표기 통일).
  const cName = (companyName || '').trim();
  const bNum = (businessNumber || '').trim();
  const existingCompanyUser = users.find(u => u.type === 'company' && (u.businessNumber || '').trim() === bNum);
  const hasExistingCompanyUser = Boolean(existingCompanyUser);
  const finalCompanyName = existingCompanyUser?.companyName || cName;
  // [수정] role/승인상태 결정 로직 자체는 src/authLogic.ts로 옮겨서 단위 테스트를 붙였다.
  const { role, approvalStatus } = decideSignupRoleAndApproval(type, hasExistingCompanyUser);

  // [추가] 이메일 인증: 메일 발송이 설정 안 된 환경(로컬 개발 등)에서는 애초에 인증
  //메일을 보낼 수가 없으므로, 가입 즉시 인증된 것으로 처리해서 개발/테스트 흐름을
  //막지 않는다. 실제 운영 환경(메일 설정 완료)에서만 진짜로 인증을 요구한다.
  const emailVerificationToken = isMailerConfigured ? crypto.randomBytes(32).toString('hex') : undefined;
  const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

  const newUser: RegisteredUser = {
    id: `user-${Date.now()}`,
    email: email.toLowerCase(),
    password: bcrypt.hashSync(password, 10), // 안전하게 암호화하여 저장
    name,
    phone: phone || undefined,
    type,
    companyName: type === 'company' ? finalCompanyName : companyName,
    businessNumber,
    position: position || undefined,
    role,
    approvalStatus,
    emailVerified: !isMailerConfigured,
    emailVerificationToken,
    emailVerificationTokenExpiresAt: emailVerificationToken ? Date.now() + EMAIL_VERIFICATION_TTL_MS : undefined,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  await addUser(newUser); // Supabase에 계정 영구 저장

  // [추가] 추천 코드로 가입한 경우, 추천인과 연결해둔다. 실제 무료 개월 보상은 지금이
  // 아니라 이 사람이 첫 구독 결제를 실제로 완료하는 시점에 지급한다 — 가입만 하고
  // 결제는 안 하는 가짜 계정을 반복해서 만드는 방식의 악용을 막기 위함이다.
  if (typeof referralCode === 'string' && referralCode.trim()) {
    const normalizedCode = referralCode.trim().toUpperCase();
    const referrer = users.find(u => u.referralCode === normalizedCode && u.id !== newUser.id);
    if (referrer) {
      newUser.referredByUserId = referrer.id;
      await addUser(newUser);
      await createReferral({
        referrerUserId: referrer.id,
        refereeUserId: newUser.id,
        refereeEmail: newUser.email,
        refereeName: newUser.name
      });
    }
  }

  // 가입 즉시 해당 스코프의 데이터 생성/초기화 유도
  const dummyReq = { headers: { 'x-user-id': newUser.id } } as unknown as express.Request;
  await loadScopeFromSupabase(resolveScopeId(dummyReq));

  // [추가] 인증 메일 발송 (실패해도 가입 자체는 막지 않는다 — 재전송 버튼으로 다시 받을 수 있음)
  if (emailVerificationToken) {
    try {
      const verifyUrl = `${APP_BASE_URL}/?verifyToken=${emailVerificationToken}`;
      await sendEmail({
        to: newUser.email,
        subject: '[BizCard] 이메일 주소를 인증해주세요',
        html: `
          <p>안녕하세요, ${escapeHtml(newUser.name)}님.</p>
          <p>아래 버튼을 눌러 이메일 인증을 완료해주세요 (24시간 이내 유효).</p>
          <p><a href="${verifyUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;">이메일 인증하기</a></p>
          <p>버튼이 안 눌리면 이 링크를 브라우저에 붙여넣어주세요: ${verifyUrl}</p>
        `
      });
    } catch (err) {
      console.error('회원가입 인증 메일 발송 실패:', err);
    }
  }

  // [수정] 가입 즉시 로그인 상태가 되도록 세션 쿠키 발급
  // [수정] 가입 즉시 로그인 상태가 되도록 세션 쿠키 발급 (가입 직후는 기본 30일 유지)
  const signupSession = await createSession(newUser.id, true);
  setSessionCookie(req, res, signupSession.token, signupSession.ttlMs);

  res.status(201).json({ 
    success: true, 
    user: { 
      id: newUser.id, 
      email: newUser.email, 
      name: newUser.name, 
      type: newUser.type, 
      companyName: newUser.companyName, 
      businessNumber: newUser.businessNumber,
      position: newUser.position,
      role: newUser.role,
      approvalStatus: newUser.approvalStatus,
      emailVerified: newUser.emailVerified
    } 
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: '이메일과 비밀번호를 모두 입력해주세요.' });
  }

  // [수정] 무차별 대입(brute-force) 방어: 같은 이메일 + 같은 IP 조합으로 짧은 시간에
  // 로그인 실패가 반복되면 잠시 잠근다. 로그인 성공 시에는 카운터를 즉시 초기화한다.
  const normalizedEmailForLimit = String(email).trim().toLowerCase();
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const limitKey = `${normalizedEmailForLimit}::${clientIp}`;
  const limitCheck = loginRateLimiter.check(limitKey);
  if (!limitCheck.allowed) {
    return res.status(429).json({
      error: `로그인 시도가 너무 많습니다. ${limitCheck.retryAfterSec}초 후 다시 시도해주세요.`
    });
  }

  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user || !verifyPassword(password, user.password)) {
    loginRateLimiter.registerAttempt(limitKey);
    return res.status(401).json({ error: '이메일 혹은 비밀번호가 일치하지 않습니다.' });
  }
  loginRateLimiter.reset(limitKey);

  // 예전 평문 비밀번호 계정이면 이번 로그인 성공을 계기로 안전한 해시로 업그레이드
  if (!user.password?.startsWith('$2')) {
    user.password = bcrypt.hashSync(password, 10);
    await addUser(user);
  }

  // [수정] 로그인 성공 시 세션 쿠키 발급 (이후 요청은 이 쿠키로만 사용자를 식별)
  // "로그인 상태 유지"를 명시적으로 껐을 때만(false) 짧은 세션을 발급하고,
  // 값이 없으면(예전 클라이언트) 기존처럼 30일 유지한다.
  const loginSession = await createSession(user.id, rememberMe !== false);
  setSessionCookie(req, res, loginSession.token, loginSession.ttlMs);

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      type: user.type,
      companyName: user.companyName,
      businessNumber: user.businessNumber,
      position: user.position,
      role: user.role,
      approvalStatus: user.approvalStatus,
      emailVerified: isEmailVerified(user.emailVerified),
      phone: user.phone,
      pendingEmail: user.pendingEmail,
      signatureImage: user.signatureImage
    }
  });
});

// [추가] 이메일 인증 링크(메일의 ?verifyToken=... 링크)를 클릭했을 때 클라이언트가 호출.
app.post('/api/auth/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: '인증 토큰이 없습니다.' });

  const user = users.find(u => u.emailVerificationToken === token);
  if (!user) return res.status(400).json({ error: '인증 링크가 유효하지 않습니다. 이미 사용됐거나 잘못된 링크일 수 있습니다.' });
  if (!user.emailVerificationTokenExpiresAt || user.emailVerificationTokenExpiresAt < Date.now()) {
    return res.status(400).json({ error: '인증 링크가 만료되었습니다. 인증 메일을 다시 받아주세요.' });
  }

  user.emailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationTokenExpiresAt = undefined;
  await addUser(user);

  res.json({ success: true, message: '이메일 인증이 완료되었습니다.' });
});

// [추가] 인증 메일을 못 받았거나 링크가 만료된 경우 재전송. 무제한으로 보낼 수 있으면
// 메일 폭탄에 악용될 수 있어 이메일+IP 기준으로 15분에 3회까지만 허용한다.
const resendVerificationRateLimiter = new RateLimiter({ maxAttempts: 3, windowMs: 15 * 60 * 1000 });

app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '이메일을 입력해주세요.' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const resendKey = `${normalizedEmail}::${clientIp}`;
  const limitCheck = resendVerificationRateLimiter.check(resendKey);
  resendVerificationRateLimiter.registerAttempt(resendKey);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: `요청이 너무 많습니다. ${limitCheck.retryAfterSec}초 후 다시 시도해주세요.` });
  }

  const user = users.find(u => u.email.toLowerCase() === normalizedEmail);
  // 보안상 가입 여부를 알려주지 않고, 항상 같은 응답을 준다.
  if (user && !isEmailVerified(user.emailVerified) && isMailerConfigured) {
    user.emailVerificationToken = crypto.randomBytes(32).toString('hex');
    user.emailVerificationTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await addUser(user);
    try {
      const verifyUrl = `${APP_BASE_URL}/?verifyToken=${user.emailVerificationToken}`;
      await sendEmail({
        to: user.email,
        subject: '[BizCard] 이메일 주소를 인증해주세요',
        html: `
          <p>안녕하세요, ${escapeHtml(user.name)}님.</p>
          <p>아래 버튼을 눌러 이메일 인증을 완료해주세요 (24시간 이내 유효).</p>
          <p><a href="${verifyUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;">이메일 인증하기</a></p>
          <p>버튼이 안 눌리면 이 링크를 브라우저에 붙여넣어주세요: ${verifyUrl}</p>
        `
      });
    } catch (err) {
      console.error('인증 메일 재전송 실패:', err);
    }
  }

  res.json({ success: true, message: '입력하신 이메일로 가입된 미인증 계정이 있다면, 인증 메일을 다시 보내드렸습니다.' });
});

// [수정] 로그아웃: 서버 세션을 즉시 무효화하고 쿠키를 지운다.
app.post('/api/auth/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) {
    sessions.delete(token);
    await deleteSession(token);
  }
  clearSessionCookie(res);
  res.json({ success: true });
});

// [수정] 새로고침/재방문 시 프런트가 로컬에 저장해둔 로그인 정보가 아직 유효한지
// 서버 세션 기준으로 재확인하기 위한 엔드포인트.
// ------------------------------------------------------------------
// [추가] 프로필 저장 / 이메일 변경
// - 프로필(이름/전화/직책)은 로그인한 본인 계정만, 허용된 항목만 바꿀 수 있다.
// - 회사명/사업자번호/역할/승인상태는 여기서 절대 바꾸지 않는다.
// - 이메일은 새 주소로 보낸 인증 링크를 눌러야만 바뀐다 (그 전까지는 기존 이메일 유지).
// ------------------------------------------------------------------
const emailChangeRateLimiter = new RateLimiter({ maxAttempts: 3, windowMs: 15 * 60 * 1000 });
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

// 클라이언트에 내려도 되는 사용자 정보만 골라낸다 (비밀번호/토큰/결제키 등은 제외)
function toClientUserShape(user: RegisteredUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    type: user.type,
    companyName: user.companyName,
    businessNumber: user.businessNumber,
    phone: user.phone,
    position: user.position,
    role: user.role,
    approvalStatus: user.approvalStatus,
    emailVerified: isEmailVerified(user.emailVerified),
    pendingEmail: user.pendingEmail,
    signatureImage: user.signatureImage
  };
}

app.put('/api/auth/profile', async (req, res) => {
  if (!checkModifyRateLimit(req, res)) return;

  const requesterId = req.headers['x-user-id'] as string;
  const user = users.find(u => u.id === requesterId);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const body = req.body || {};
  const validationError = validateProfileFields(body);
  if (validationError) return res.status(400).json({ error: validationError });

  if (typeof body.name === 'string') user.name = body.name.trim();
  if (body.phone !== undefined) {
    user.phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : undefined;
  }
  // 직책은 회사 소속 사용자에게만 의미가 있다
  if (body.position !== undefined && user.type === 'company') {
    user.position = typeof body.position === 'string' && body.position.trim() ? body.position.trim() : undefined;
  }

  await addUser(user);
  res.json({ success: true, user: toClientUserShape(user) });
});

// 1단계: 새 이메일 + 현재 비밀번호를 받아, 새 주소로 인증 링크를 보낸다. 이 단계에서는 이메일을 바꾸지 않는다.
app.post('/api/auth/email/change-request', async (req, res) => {
  if (!checkModifyRateLimit(req, res)) return;

  const requesterId = req.headers['x-user-id'] as string;
  const user = users.find(u => u.id === requesterId);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const { newEmail, password } = req.body || {};
  if (typeof newEmail !== 'string' || !isValidEmail(newEmail)) {
    return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다.' });
  }
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: '현재 비밀번호를 입력해주세요.' });
  }
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (normalizedEmail === user.email.toLowerCase()) {
    return res.status(400).json({ error: '현재 사용 중인 이메일과 같습니다.' });
  }

  // 비밀번호를 틀리는 시도도 횟수에 포함되도록, 검사 전에 먼저 기록한다
  const limitCheck = emailChangeRateLimiter.check(user.id);
  emailChangeRateLimiter.registerAttempt(user.id);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: `요청이 너무 많습니다. ${limitCheck.retryAfterSec}초 후 다시 시도해주세요.` });
  }

  if (!user.password || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
  }
  if (users.some(u => u.id !== user.id && u.email.toLowerCase() === normalizedEmail)) {
    return res.status(400).json({ error: '이미 사용 중인 이메일입니다.' });
  }
  // 인증 메일을 보낼 수 없으면 주소를 바꿔 버리면 안 되므로 요청 자체를 막는다
  if (!isMailerConfigured) {
    return res.status(503).json({ error: '메일 발송 설정이 없어 이메일을 변경할 수 없습니다. 관리자에게 문의해주세요.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  user.pendingEmail = normalizedEmail;
  user.pendingEmailToken = token;
  user.pendingEmailTokenExpiresAt = Date.now() + EMAIL_CHANGE_TTL_MS;
  await addUser(user);

  try {
    const confirmUrl = `${APP_BASE_URL}/?emailChangeToken=${token}`;
    await sendEmail({
      to: normalizedEmail,
      subject: '[BizCard] 새 이메일 주소를 인증해주세요',
      html: `
        <p>안녕하세요, ${escapeHtml(user.name)}님.</p>
        <p>BizCard 계정의 이메일을 이 주소로 변경하려고 합니다. 아래 버튼을 눌러 변경을 완료해주세요 (24시간 이내 유효).</p>
        <p><a href="${confirmUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;">새 이메일 인증하기</a></p>
        <p>본인이 요청하지 않았다면 이 메일을 무시해주세요. 이메일은 링크를 누르기 전까지 바뀌지 않습니다.</p>
      `
    });
  } catch (err) {
    console.error('이메일 변경 인증 메일 발송 실패:', err);
    user.pendingEmail = undefined;
    user.pendingEmailToken = undefined;
    user.pendingEmailTokenExpiresAt = undefined;
    await addUser(user);
    return res.status(500).json({ error: '인증 메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }

  res.json({ success: true, pendingEmail: normalizedEmail, message: '새 이메일로 인증 메일을 보냈습니다. 메일의 링크를 누르면 변경됩니다.' });
});

// 2단계: 새 주소로 받은 링크의 토큰을 확인하고 이메일을 바꾼다. 토큰이 곧 본인 확인 수단이다.
app.post('/api/auth/email/confirm', async (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: '인증 토큰이 없습니다.' });

  const user = users.find(u => u.pendingEmailToken === token);
  if (!user || !user.pendingEmail) {
    return res.status(400).json({ error: '인증 링크가 유효하지 않습니다. 이미 사용됐거나 잘못된 링크일 수 있습니다.' });
  }

  const clearPending = async () => {
    user.pendingEmail = undefined;
    user.pendingEmailToken = undefined;
    user.pendingEmailTokenExpiresAt = undefined;
    await addUser(user);
  };

  if (!user.pendingEmailTokenExpiresAt || user.pendingEmailTokenExpiresAt < Date.now()) {
    await clearPending();
    return res.status(400).json({ error: '인증 링크가 만료되었습니다. 이메일 변경을 다시 요청해주세요.' });
  }

  const newEmail = user.pendingEmail;
  // 요청 후 다른 사람이 같은 주소로 가입했을 수 있으므로 한 번 더 확인한다
  if (users.some(u => u.id !== user.id && u.email.toLowerCase() === newEmail)) {
    await clearPending();
    return res.status(400).json({ error: '이미 사용 중인 이메일입니다. 다른 이메일로 다시 요청해주세요.' });
  }

  const oldEmail = user.email;
  user.email = newEmail;
  user.emailVerified = true;
  await clearPending();

  // 기존 주소로도 변경 사실을 알려서, 본인이 모르는 변경을 빨리 알아챌 수 있게 한다
  if (isMailerConfigured) {
    try {
      await sendEmail({
        to: oldEmail,
        subject: '[BizCard] 로그인 이메일이 변경되었습니다',
        html: `<p>${escapeHtml(user.name)}님, BizCard 계정의 이메일이 ${escapeHtml(newEmail)} 로 변경되었습니다. 본인이 변경하지 않았다면 즉시 관리자에게 문의해주세요.</p>`
      });
    } catch (err) {
      console.error('이메일 변경 알림 메일 발송 실패:', err);
    }
  }

  res.json({ success: true, email: newEmail, message: '이메일이 변경되었습니다. 새 이메일로 로그인해주세요.' });
});

app.get('/api/auth/me', (req, res) => {
  const userId = req.headers['x-user-id'] as string; // 세션 미들웨어가 검증한 경우에만 존재
  const user = userId ? users.find(u => u.id === userId) : undefined;
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });

  // DB에서 로드된 데이터
  const dbData = getScopedData(req);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      type: user.type,
      companyName: user.companyName,
      businessNumber: user.businessNumber,
      position: user.position,
      role: user.role,
      approvalStatus: user.approvalStatus,
      emailVerified: isEmailVerified(user.emailVerified),
      phone: user.phone,
      pendingEmail: user.pendingEmail,
      signatureImage: user.signatureImage,
      // DB에서 로드된 모든 사용자 데이터
      businessCards: dbData.contacts || [],
      vehicles: dbData.vehicles || [],
      workLogs: dbData.weeklyLogs || [],
      dailyLogs: dbData.dailyLogs || [],
      projects: dbData.projects || [],
      expenses: dbData.expenses || []
    }
  });
});

// [추가] 전자결재 승인 시 도장처럼 찍히는 손글씨 서명 등록/변경. 본인 것만 바꿀 수 있고
// (다른 사람 서명을 대신 등록할 수 없게), 회사 동료 목록(/api/auth/users)에는 이 필드를
// 절대 내려주지 않는다 - 서명 URL이 넓게 퍼지면 다른 사람이 그 이미지를 내려받아 문서에
// 도용할 위험이 있기 때문에, 본인 정보 조회(로그인/me/이 엔드포인트의 응답)에서만 노출한다.
app.put('/api/auth/signature', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const { signatureImage } = req.body;
  if (typeof signatureImage !== 'string' || !signatureImage.startsWith('data:image/')) {
    return res.status(400).json({ error: '서명 이미지 형식이 올바르지 않습니다.' });
  }

  // [추가] DB 저장 실패 시 되돌리기 위해 수정 전 서명을 남겨둔다.
  const previousSignatureImage = user.signatureImage;
  user.signatureImage = await persistImageField(scopeIdForUser(user), signatureImage, `sig-${user.id}`, 'signatures');
  // [수정] 서명 저장이 DB에 실제로 실패했는데도 조용히 "성공"으로 응답하던 문제를 고쳤다.
  const savedUser = await addUser(user);
  if (!savedUser) {
    user.signatureImage = previousSignatureImage;
    return res.status(500).json({ error: '서명 이미지를 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      type: user.type,
      companyName: user.companyName,
      businessNumber: user.businessNumber,
      position: user.position,
      role: user.role,
      approvalStatus: user.approvalStatus,
      emailVerified: isEmailVerified(user.emailVerified),
      signatureImage: user.signatureImage
    }
  });
});

// ------------------------------------------------------------------
// 🔑 비밀번호 찾기 (이메일로 재설정 링크 발송)
// 토큰은 메모리에만 저장 (서버 재시작 시 만료된 요청은 그냥 다시 받으면 됨). 유효시간 30분.
// ------------------------------------------------------------------
const passwordResetTokens = new Map<string, { userId: string; expiresAt: number }>();
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30분

// [수정] 로그인과 같은 방식의 레이트리밋을 비밀번호 찾기에도 적용한다. 이게 없으면
// 봇이 특정 이메일로 재설정 요청을 반복 호출해 "메일 폭탄"을 보내거나, 메일 발송
// API(Brevo) 사용량을 소진시킬 수 있다. 로그인보다는 더 관대하게(15분에 3회) 둔다 —
// 정상 사용자도 메일이 안 왔다고 몇 번 다시 누를 수 있기 때문이다.
const forgotPasswordRateLimiter = new RateLimiter({ maxAttempts: 3, windowMs: 15 * 60 * 1000 });

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '이메일을 입력해주세요.' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const forgotKey = `${normalizedEmail}::${clientIp}`;
  const limitCheck = forgotPasswordRateLimiter.check(forgotKey);
  forgotPasswordRateLimiter.registerAttempt(forgotKey);
  if (!limitCheck.allowed) {
    // 보안상 "가입 여부"는 여전히 숨기되, 너무 잦은 요청 자체는 막는다.
    return res.status(429).json({ error: `요청이 너무 많습니다. ${limitCheck.retryAfterSec}초 후 다시 시도해주세요.` });
  }

  const user = users.find(u => u.email.toLowerCase() === normalizedEmail);

  // 보안상 "가입된 이메일인지" 여부를 응답으로 알려주지 않는다 (등록 여부와 상관없이 동일한 안내).
  if (user && isMailerConfigured) {
    // [수정] 새 토큰을 발급하기 전에 이 사용자의 기존 재설정 토큰을 먼저 무효화한다.
    // 안 그러면 예전에 받은 메일 링크가 새 링크와 함께 계속 유효한 상태로 남는다.
    // (메모리뿐 아니라 Supabase에 저장된 예전 토큰도 함께 지운다.)
    for (const [existingToken, entry] of passwordResetTokens.entries()) {
      if (entry.userId === user.id) passwordResetTokens.delete(existingToken);
    }
    await deleteAllPasswordResetTokensForUser(user.id);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + RESET_TOKEN_TTL_MS;
    passwordResetTokens.set(token, { userId: user.id, expiresAt });
    // [추가] 메모리에만 두면 배포 플랫폼이 서버를 재웠다가 깨울 때(cold start) 사라져서,
    // 받은 지 얼마 안 된 메일 링크도 "유효하지 않다"고 실패하는 문제가 있었다. 세션과
    // 동일하게 Supabase에도 영구 저장한다(미설정 시 조용히 무시됨).
    await savePasswordResetToken(token, user.id, expiresAt);

    const resetUrl = `${APP_BASE_URL}/?resetToken=${token}`;
    try {
      await sendEmail({
        to: user.email,
        toName: user.name,
        subject: '[BizCard] 비밀번호 재설정 안내',
        html: `
          <div style="font-family: 'Malgun Gothic', sans-serif; padding: 24px; color:#111;">
            <h2 style="margin-bottom:4px;">비밀번호 재설정</h2>
            <p style="color:#555;">${user.name}님, 비밀번호 재설정을 요청하셨습니다. 아래 버튼을 눌러 새 비밀번호를 설정해주세요.</p>
            <p style="color:#999; font-size:12px;">이 링크는 30분 동안만 유효합니다. 본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다.</p>
            <a href="${resetUrl}" style="display:inline-block; margin-top:12px; padding:10px 22px; background:#4f46e5; color:#fff; text-decoration:none; border-radius:8px; font-weight:bold;">새 비밀번호 설정하기</a>
          </div>
        `
      });
      console.log(`[mailer] ${user.email}에게 비밀번호 재설정 메일 발송 완료`);
    } catch (err) {
      console.error(`[mailer] ${user.email}에게 비밀번호 재설정 메일 발송 실패:`, err);
    }
  } else if (user && !isMailerConfigured) {
    console.warn('[mailer] 메일 미설정으로 비밀번호 재설정 메일을 보내지 못했습니다.');
  }

  res.json({ success: true, message: '입력하신 이메일로 가입된 계정이 있다면, 비밀번호 재설정 안내 메일을 보내드렸습니다.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: '재설정 토큰과 새 비밀번호를 모두 입력해주세요.' });
  // [추가] 비밀번호 복잡도 검증 (회원가입과 동일한 기준)
  const passwordValidation = validatePasswordComplexity(newPassword);
  if (!passwordValidation.valid) {
    return res.status(400).json({ error: passwordValidation.error });
  }

  // [수정] 메모리 캐시(passwordResetTokens)에 없으면(=서버가 방금 재시작돼서 캐시가
  // 비어있는 경우 포함) Supabase에서 한 번 더 확인한다 — 로그인 세션 검증과 동일한
  // 패턴. 이 한 단계 덕분에 링크를 받고 시간이 좀 지나 서버가 재시작됐어도(Render의
  // cold start 등) 30분 TTL 안이면 정상적으로 재설정할 수 있다.
  let entry = passwordResetTokens.get(token);
  if (!entry && process.env.DATABASE_URL) {
    const stored = await loadPasswordResetToken(token);
    if (stored) {
      entry = { userId: stored.userId, expiresAt: stored.expiresAt };
      passwordResetTokens.set(token, entry);
    }
  }
  if (!entry || entry.expiresAt < Date.now()) {
    passwordResetTokens.delete(token);
    await deletePasswordResetToken(token);
    return res.status(400).json({ error: '재설정 링크가 만료되었거나 유효하지 않습니다. 비밀번호 찾기를 다시 요청해주세요.' });
  }

  const user = users.find(u => u.id === entry.userId);
  if (!user) {
    passwordResetTokens.delete(token);
    await deletePasswordResetToken(token);
    return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  }

  user.password = bcrypt.hashSync(newPassword, 10);
  await addUser(user);
  passwordResetTokens.delete(token);
  await deletePasswordResetToken(token);

  // [수정] 비밀번호가 바뀌었으니, 그동안 이 계정으로 로그인돼 있던 세션(공격자 것일 수도 있는)을
  // 전부 끊는다. 지금 이 요청으로 새로 로그인시키지는 않으므로, 사용자는 새 비밀번호로 다시
  // 로그인해야 한다 — 이건 의도된 동작이다.
  await invalidateAllSessionsForUser(user.id);

  res.json({ success: true, message: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.' });
});

// 👥 Registered Users Directory API
app.get('/api/auth/users', (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const toPublicShape = (u: RegisteredUser) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    type: u.type,
    companyName: u.companyName,
    businessNumber: u.businessNumber,
    position: u.position,
    role: u.role,
    approvalStatus: u.approvalStatus,
    // [추가] 관리자 화면(가입 회원 디렉토리)에서 "이 사람이 이메일 인증을 못 받았는지"
    // 알아야, 국내 메일(Daum/Naver)이 인증 메일을 스팸으로 자동 차단해서 못 받는
    // 경우에 관리자가 수동 인증 버튼을 보여줄 수 있다.
    emailVerified: isEmailVerified(u.emailVerified),
    // [추가] 조직도 화면에서 부서/보고 체계를 그리기 위한 필드.
    department: u.department,
    managerUserId: u.managerUserId,
    createdAt: u.createdAt
  });

  // [수정] 개발자(운영자) 계정은 전체 가입 회원(모든 회사 포함)을 다 볼 수 있다.
  // 그 외 일반 회원(회사 관리자 포함)은 "같은 회사(사업자번호 기준)" 사람만 볼 수 있다.
  // 개인 회원은 다른 회사/개인 정보를 볼 필요가 없으므로 본인 정보만 반환한다.
  let visible: RegisteredUser[];
  if (requester.email === ADMIN_EMAIL) {
    visible = users;
  } else if (requester.type === 'company') {
    const bNum = (requester.businessNumber || '').trim().toLowerCase();
    visible = users.filter(u =>
      u.type === 'company' && (u.businessNumber || '').trim().toLowerCase() === bNum
    );
  } else {
    visible = [requester];
  }

  res.json(visible.map(toPublicShape));
});

// [추가] 조직도 / 사내 메신저 전용: "내 회사(같은 사업자번호) 동료만" 반환한다.
// 위 /api/auth/users는 개발자(운영자, ADMIN_EMAIL) 계정에게 전체 회사를 다 보여주도록
// 되어 있는데, 이건 "가입 회원 확인"(고객사 지원용 전체 조회) 화면 전용 의도였다.
// 그런데 조직도/메신저가 실수로 그 API를 그대로 재사용하면서, 운영자 계정(Tony님 본인)
// 이 자기 조직도나 메신저를 열 때도 카이저솔루션/나래디엔에이 등 다른 회사 직원까지
// 전부 섞여서 보이는 문제가 있었다. 이 API는 요청자가 누구든(운영자 포함) 예외 없이
// 본인과 같은 사업자번호 소속만 돌려준다.
app.get('/api/org/coworkers', (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const toPublicShape = (u: RegisteredUser) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    position: u.position,
    role: u.role,
    approvalStatus: u.approvalStatus,
    department: u.department,
    managerUserId: u.managerUserId
  });

  let visible: RegisteredUser[];
  if (requester.type === 'company') {
    const bNum = (requester.businessNumber || '').trim().toLowerCase();
    visible = users.filter(u => u.type === 'company' && (u.businessNumber || '').trim().toLowerCase() === bNum);
  } else {
    visible = [requester];
  }

  res.json(visible.map(toPublicShape));
});

// 진단용: 같은 이메일로 여러 계정이 만들어진 경우(예: 개인+사업자 중복 가입)를 찾아서 보여준다.
// 삭제는 안전을 위해 여기서 하지 않고, 확인 후 Supabase 테이블 편집기에서 직접 지우는 걸 권장한다.
app.get('/api/auth/duplicate-emails', async (req, res) => {
  const all = process.env.DATABASE_URL ? await getUsers() : users;
  const byEmail = new Map<string, RegisteredUser[]>();
  for (const u of all) {
    const key = u.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key)!.push(u);
  }
  const duplicates = Array.from(byEmail.entries())
    .filter(([, list]) => list.length > 1)
    .map(([email, list]) => ({
      email,
      accounts: list.map(u => ({ id: u.id, type: u.type, companyName: u.companyName, businessNumber: u.businessNumber, position: u.position, role: u.role }))
    }));
  res.json({ duplicateCount: duplicates.length, duplicates });
});

// 회사 스코프 판별에 쓰이는 것과 동일한 규칙 (resolveScopeId와 반드시 일치시켜야 함)
// [수정] 예전엔 "회사명 + 사업자번호"로 스코프를 구분했는데, 같은 회사라도 가입할 때
// "(주)OO"와 "주식회사OO"처럼 회사명 표기가 조금만 달라도 완전히 다른 회사로 취급되어
// 데이터가 쪼개지는 문제가 있었다(카이저솔루션에서 실제로 발생). 사업자등록번호는
// 법적으로 회사마다 유일하고 표기가 갈릴 일이 없으므로, 이제는 사업자번호 하나만으로
// 회사를 구분한다.
// [수정] 이 함수는 이제 src/authLogic.ts로 옮겨서 단위 테스트를 붙였다 (아래 import 참고).
// 로직 자체는 그대로: 회사 계정은 사업자등록번호로, 개인 계정은 본인 id로 스코프를 나눈다.

// 관리자 전용: 같은 회사 소속 사용자의 직책/권한 수정 (결재라인 매칭 및 직원 관리용)
app.put('/api/auth/users/:targetId', async (req, res) => {
  // ✅ 데이터 수정 Rate Limiting
  if (!checkModifyRateLimit(req, res)) return;

  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: '관리자만 직원 정보를 수정할 수 있습니다.' });

  const target = users.find(u => u.id === req.params.targetId);
  if (!target) return res.status(404).json({ error: '대상 사용자를 찾을 수 없습니다.' });
  if (scopeIdForUser(requester) !== scopeIdForUser(target)) {
    return res.status(403).json({ error: '같은 회사 소속 사용자만 수정할 수 있습니다.' });
  }

  const { position, role, department, managerUserId } = req.body;
  const prevRole = target.role;
  if (typeof position === 'string') target.position = position;
  if (role === 'admin' || role === 'member') target.role = role;
  // [추가] 조직도(부서/직속 상사) 편집. 관리자만 바꿀 수 있고, 빈 문자열을 보내면
  // "미배정"으로 지운다. 자기 자신을 자기 상사로 지정하는 것만 막는다(순환은 화면에서
  // 트리를 그릴 때 자연히 무시되므로 서버에서 굳이 깊게 검증하지 않는다).
  if (typeof department === 'string') target.department = department.trim() || undefined;
  if (typeof managerUserId === 'string') {
    target.managerUserId = (managerUserId.trim() && managerUserId !== target.id) ? managerUserId.trim() : undefined;
  }
  await addUser(target);

  // [추가] 관리자가 동료 역할을 바꾼 기록을 남긴다.
  if (role && role !== prevRole) {
    await logAudit({
      scopeId: scopeIdForUser(requester),
      actorUserId: requester.id,
      actorEmail: requester.email,
      action: 'role_change',
      targetUserId: target.id,
      targetEmail: target.email,
      detail: { from: prevRole || null, to: target.role }
    });
  }

  res.json({ success: true, user: { id: target.id, email: target.email, name: target.name, position: target.position, role: target.role, department: target.department, managerUserId: target.managerUserId } });
});

// [추가] 관리자 전용: 이미 승인된 동료를 팀에서 제거(계정 삭제)한다. 기존에는 승인 대기
// 상태(reject)에서만 계정을 지울 수 있었고, 이미 승인된 멤버를 내보낼 방법이 없었다.
// 본인 계정은 이 API로 지울 수 없다 (본인 탈퇴는 /api/auth/withdraw를 써야 하며, 그쪽은
// 비밀번호 확인과 "나 혼자 관리자인데 동료가 남아있으면 탈퇴 불가" 안전장치가 있다).
// 같은 이유로 여기서도 "제거 후 그 회사에 관리자가 한 명도 안 남는" 경우는 막는다.
app.delete('/api/auth/users/:targetId', async (req, res) => {
  // ✅ 데이터 수정 Rate Limiting
  if (!checkModifyRateLimit(req, res)) return;

  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: '관리자만 동료를 제거할 수 있습니다.' });

  const target = users.find(u => u.id === req.params.targetId);
  if (!target) return res.status(404).json({ error: '대상 사용자를 찾을 수 없습니다.' });
  if (scopeIdForUser(requester) !== scopeIdForUser(target)) {
    return res.status(403).json({ error: '같은 회사 소속 사용자만 제거할 수 있습니다.' });
  }
  if (target.id === requester.id) {
    return res.status(400).json({ error: '본인 계정은 이 기능으로 제거할 수 없습니다. 탈퇴는 "회원 탈퇴" 메뉴를 이용해주세요.' });
  }

  if (target.role === 'admin') {
    const scopeId = scopeIdForUser(requester);
    const anotherAdminExists = users.some(u => u.id !== target.id && scopeIdForUser(u) === scopeId && u.role === 'admin');
    if (!anotherAdminExists) {
      return res.status(400).json({ error: '이 회사의 마지막 관리자는 제거할 수 없습니다. 다른 동료를 먼저 관리자로 지정해주세요.' });
    }
  }

  // [수정] 계정을 지우기 전에 감사 로그부터 남긴다 (지운 뒤에는 대상 이메일 등 정보가 사라짐).
  await logAudit({
    scopeId: scopeIdForUser(requester),
    actorUserId: requester.id,
    actorEmail: requester.email,
    action: 'member_remove',
    targetUserId: target.id,
    targetEmail: target.email,
    detail: { role: target.role || null }
  });

  users = users.filter(u => u.id !== target.id);
  await deleteUser(target.id);
  await invalidateAllSessionsForUser(target.id);
  res.json({ success: true });
});

// 관리자 전용: 최근 관리자 작업 감사 로그 조회 (역할 변경, 승인/거절 등)
// [추가] 운영자 전용: 사업자번호는 같은데 회사명 표기가 갈려서(예: "(주)OO" vs "주식회사 OO")
// 화면에 별도 회사로 나뉘어 보이는 사례를 전체 훑어서 찾아준다. 실제 데이터(명함 등)는
// 사업자번호 기준으로 이미 공유되고 있으니, 여기서는 "표시용 회사명"만 통일하면 된다.
app.get('/api/admin/company-name-mismatches', (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester || requester.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }

  const byBusinessNumber = new Map<string, { companyName: string; count: number }[]>();
  for (const u of users) {
    if (u.type !== 'company' || !u.businessNumber) continue;
    const bNum = u.businessNumber.trim();
    const cName = (u.companyName || '').trim();
    if (!bNum || !cName) continue;
    const arr = byBusinessNumber.get(bNum) || [];
    const found = arr.find(x => x.companyName === cName);
    if (found) found.count++; else arr.push({ companyName: cName, count: 1 });
    byBusinessNumber.set(bNum, arr);
  }

  const mismatches = Array.from(byBusinessNumber.entries())
    .filter(([, names]) => names.length > 1)
    .map(([businessNumber, names]) => ({ businessNumber, variants: names }));

  res.json(mismatches);
});

// [추가] 운영자 전용: 특정 사업자번호에 속한 모든 사용자의 회사명 표기를 하나로 통일한다.
app.post('/api/admin/normalize-company-name', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester || requester.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }

  const { businessNumber, canonicalName } = req.body;
  if (!businessNumber || !canonicalName) {
    return res.status(400).json({ error: 'businessNumber와 canonicalName이 모두 필요합니다.' });
  }

  const bNum = String(businessNumber).trim();
  const targets = users.filter(u => u.type === 'company' && (u.businessNumber || '').trim() === bNum);
  if (targets.length === 0) {
    return res.status(404).json({ error: '해당 사업자번호로 가입된 사용자가 없습니다.' });
  }

  let updatedCount = 0;
  for (const u of targets) {
    if (u.companyName !== canonicalName) {
      u.companyName = canonicalName;
      await addUser(u);
      updatedCount++;
    }
  }

  await logAudit({
    scopeId: `company:${bNum}`,
    actorUserId: requester.id,
    actorEmail: requester.email,
    action: 'company_name_normalized',
    detail: { businessNumber: bNum, canonicalName, updatedCount }
  });

  res.json({ success: true, updatedCount });
});

app.get('/api/auth/audit-logs', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: '관리자만 조회할 수 있습니다.' });

  const logs = await getAuditLogs(scopeIdForUser(requester));
  res.json(logs);
});

// [추가] 관리자 전용: 우리 회사(또는 내 개인 계정) 데이터 전체를 JSON 하나로 내려받는다.
// 명함/프로젝트/차량/업무일지 등 이 스코프의 모든 데이터를 백업 목적으로 한 번에 export.
// 개인(individual) 계정은 본인 데이터니까 role 제한 없이 내려받을 수 있고, 회사 계정은
// admin만 가능하다(직원이 회사 전체 데이터를 통째로 빼갈 수 없도록).
// [추가] 로그인/관리자 권한이 필요하긴 하지만, 반복 호출로 DB에 부하를 줄 수 있어
// 계정 기준으로 5분에 3회까지만 허용한다.
const backupExportRateLimiter = new RateLimiter({ maxAttempts: 3, windowMs: 5 * 60 * 1000 });

// [추가] 백업에 포함할 전체 14개 컬렉션을 한 곳에 모아둔다. 수동 다운로드(아래 /api/backup/export)와
// 자동 이메일 백업(runDailyReportAndBackupBatch)이 이 함수 하나를 공유해서 쓴다 - 예전엔 이 목록을
// 각자 따로 나열해서, 나중에 officialDocuments(공문서) 컬렉션이 통째로 빠져있던 걸 뒤늦게 발견했다.
function buildBackupDataPayload(dbData: typeof db[string]) {
  return {
    contacts: dbData.contacts,
    projects: dbData.projects,
    groups: dbData.groups,
    myProfile: dbData.myProfile,
    vehicles: dbData.vehicles,
    drivingLogs: dbData.drivingLogs,
    expenses: dbData.expenses,
    maintenances: dbData.maintenances,
    maintenanceIntervals: dbData.maintenanceIntervals,
    dailyLogs: dbData.dailyLogs,
    weeklyLogs: dbData.weeklyLogs,
    advancePayments: dbData.advancePayments,
    leaveRequests: dbData.leaveRequests,
    officialDocuments: dbData.officialDocuments,
    adminDocs: dbData.adminDocs
  };
}

app.get('/api/backup/export', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (requester.type === 'company' && requester.role !== 'admin') {
    return res.status(403).json({ error: '회사 계정은 관리자만 전체 백업을 내려받을 수 있습니다.' });
  }
  const backupLimit = backupExportRateLimiter.check(requester.id);
  backupExportRateLimiter.registerAttempt(requester.id);
  if (!backupLimit.allowed) {
    return res.status(429).json({ error: `요청이 너무 많습니다. ${backupLimit.retryAfterSec}초 후 다시 시도해주세요.` });
  }

  const dbData = getScopedData(req);
  const backup = {
    exportedAt: new Date().toISOString(),
    exportedBy: { id: requester.id, email: requester.email, name: requester.name },
    scope: requester.type === 'company'
      ? { type: 'company', companyName: requester.companyName, businessNumber: requester.businessNumber }
      : { type: 'individual' },
    data: buildBackupDataPayload(dbData)
  };

  await logAudit({
    scopeId: scopeIdForUser(requester),
    actorUserId: requester.id,
    actorEmail: requester.email,
    action: 'data_backup_export'
  });

  const dateStr = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Disposition', `attachment; filename="bizcard-backup-${dateStr}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(backup, null, 2));
});

// ------------------------------------------------------------------
// 🗑️ 회원 탈퇴
// [추가] 개인정보처리방침에 "회원 탈퇴를 요청한 경우 지체 없이 파기한다"고 명시돼 있는데,
// 정작 탈퇴 기능이 없었다. 세션 탈취 등으로 악용되지 않도록 비밀번호 재확인을 받는다.
//
// - 개인(individual) 계정: 그 스코프가 곧 본인 데이터 전부이므로, 명함/프로젝트/차량기록
//   등을 전부 지우고 계정도 삭제한다.
// - 회사(company) 계정: 동료들과 데이터를 공유하는 구조라, 회사 데이터까지 지우면 다른
//   사람들 업무가 멈춘다. 그래서 "이 사람 계정"만 지우고 회사 데이터는 그대로 둔다.
//   단, 그 회사의 유일한 관리자인데 다른 동료가 남아있으면, 관리자가 없어져 아무도
//   승인/관리를 못 하게 되므로 먼저 다른 사람에게 관리자 권한을 넘기도록 안내하고 막는다.
// ------------------------------------------------------------------
app.post('/api/auth/withdraw', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const { password } = req.body;
  if (!password || !verifyPassword(password, requester.password)) {
    return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });
  }

  if (requester.type === 'company' && requester.role === 'admin') {
    const scopeId = scopeIdForUser(requester);
    const otherMembersExist = users.some(u => u.id !== requester.id && scopeIdForUser(u) === scopeId);
    const anotherAdminExists = users.some(u => u.id !== requester.id && scopeIdForUser(u) === scopeId && u.role === 'admin');
    if (otherMembersExist && !anotherAdminExists) {
      return res.status(400).json({
        error: '아직 소속된 동료가 있는데 관리자가 본인 한 명뿐입니다. 다른 동료를 관리자로 먼저 지정한 뒤 탈퇴해주세요.'
      });
    }
  }

  await logAudit({
    scopeId: scopeIdForUser(requester),
    actorUserId: requester.id,
    actorEmail: requester.email,
    action: 'account_withdraw',
    detail: { type: requester.type }
  });

  // 개인 계정만 데이터까지 완전히 파기 (회사 계정은 동료 공유 데이터라 계정만 삭제)
  if (requester.type === 'individual') {
    const scopeId = scopeIdForUser(requester);
    delete db[scopeId];
    await deleteScopeCompletely(scopeId);
  }

  users = users.filter(u => u.id !== requester.id);
  await deleteUser(requester.id);
  await invalidateAllSessionsForUser(requester.id);
  clearSessionCookie(res);

  res.json({ success: true, message: '탈퇴 처리가 완료되었습니다.' });
});

// ------------------------------------------------------------------
// 💳 구독/결제 (토스페이먼츠 자동결제)
// [추가] 인원(좌석)당 요금 × 승인된 회사 구성원 수로 매달 자동결제한다.
// 결제 관리는 그 회사의 관리자(admin) 계정 기준으로 이뤄진다 — 회사 전체가 admin 한 명의
// 카드로 결제되는 구조다. 개인(individual) 계정도 동일한 방식으로 구독할 수 있다(좌석 1개 고정).
//
// ⚠️ 실제 운영(라이브 키)에서 자동결제를 쓰려면 토스페이먼츠 고객센터(1544-7772,
// support@tosspayments.com)로 별도 계약을 먼저 신청해야 한다. 테스트 키로는 지금 바로
// 테스트할 수 있다.
// ------------------------------------------------------------------
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';
const SUBSCRIPTION_PRICE_PER_SEAT_KRW = Number(process.env.SUBSCRIPTION_PRICE_PER_SEAT_KRW) || 9900;
// [추가] 최초 구독 시 무료 체험 기간(일). 계정당 한 번만 적용된다(owner.trialUsed).
const SUBSCRIPTION_TRIAL_DAYS = 14;
// [추가] 기간 약정 할인(선결제): 1년 10%, 3년 20%. 월 구독은 할인 없음. 5년 약정은 제외.
const SUBSCRIPTION_TERM_DISCOUNTS: Record<number, number> = { 1: 0.1, 3: 0.2 };
const subscriptionTermAmount = (seats: number, years: number): number => {
  const discount = SUBSCRIPTION_TERM_DISCOUNTS[years] ?? 0;
  return Math.round(seats * SUBSCRIPTION_PRICE_PER_SEAT_KRW * 12 * years * (1 - discount));
};
const addMonthsN = (date: Date, months: number): Date => {
  let d = new Date(date);
  for (let i = 0; i < months; i++) d = addOneMonth(d);
  return d;
};

function seatCountForScope(scopeId: string): number {
  // 승인된(=실제로 서비스를 쓸 수 있는) 구성원 수만 과금 대상으로 센다. 개인 계정은 항상 1석.
  return Math.max(1, users.filter(u => scopeIdForUser(u) === scopeId && u.approvalStatus !== 'pending').length);
}

function billingOwnerForRequester(requester: RegisteredUser): RegisteredUser | null {
  // 회사 계정이면 결제를 관리하는 사람은 "그 회사의 관리자"다 (일반 사용자는 결제를 만들 수 없다).
  // 개인 계정이면 본인이 곧 결제 주체다.
  if (requester.type === 'individual') return requester;
  if (requester.role === 'admin') return requester;
  return null;
}

// 구독 시작 전, 토스 카드 등록창(requestBillingAuth)에 넘길 고객키를 발급/조회한다.
app.get('/api/billing/customer-key', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const owner = billingOwnerForRequester(requester);
  if (!owner) return res.status(403).json({ error: '회사 계정은 관리자만 구독을 관리할 수 있습니다.' });

  if (!owner.tossCustomerKey) {
    owner.tossCustomerKey = generateCustomerKey();
    addUser(owner).catch((err) => console.error('customerKey 저장 실패:', err));
  }
  res.json({ customerKey: owner.tossCustomerKey });
});

// 카드 등록 완료(카드 등록창에서 authKey를 받은 뒤) → 빌링키 발급 및 저장
app.post('/api/billing/register-card', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const owner = billingOwnerForRequester(requester);
  if (!owner) return res.status(403).json({ error: '회사 계정은 관리자만 구독을 관리할 수 있습니다.' });
  if (!TOSS_SECRET_KEY) return res.status(500).json({ error: '결제 기능이 아직 설정되지 않았습니다 (TOSS_SECRET_KEY 없음).' });

  const { authKey } = req.body;
  if (!authKey || !owner.tossCustomerKey) {
    return res.status(400).json({ error: '카드 등록 정보가 올바르지 않습니다. 처음부터 다시 시도해주세요.' });
  }

  try {
    const result = await issueBillingKey(TOSS_SECRET_KEY, authKey, owner.tossCustomerKey);
    owner.tossBillingKey = result.billingKey;
    await addUser(owner);
    await logAudit({
      scopeId: scopeIdForUser(owner),
      actorUserId: owner.id,
      actorEmail: owner.email,
      action: 'billing_card_registered'
    });
    res.json({ success: true, card: result.card });
  } catch (err: unknown) {
    console.error('카드 등록 실패:', err);
    res.status(400).json({ error: getErrorMessage(err) || '카드 등록에 실패했습니다.' });
  }
});

// 구독 시작: 등록된 빌링키로 이번 달분을 즉시 결제하고, 다음 결제일을 잡는다.
app.post('/api/billing/subscribe', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const owner = billingOwnerForRequester(requester);
  if (!owner) return res.status(403).json({ error: '회사 계정은 관리자만 구독을 관리할 수 있습니다.' });
  if (!TOSS_SECRET_KEY) return res.status(500).json({ error: '결제 기능이 아직 설정되지 않았습니다 (TOSS_SECRET_KEY 없음).' });
  if (!owner.tossBillingKey || !owner.tossCustomerKey) {
    return res.status(400).json({ error: '먼저 카드를 등록해주세요.' });
  }

  // [추가] 기간 약정(termYears: 1 또는 3)을 선택하면 선결제 금액과 할인이 적용된다. 0/없음이면 월 구독.
  const termYears = Number((req.body && req.body.termYears) || 0);
  if (termYears && !(termYears in SUBSCRIPTION_TERM_DISCOUNTS)) {
    return res.status(400).json({ error: '지원하지 않는 약정 기간입니다 (1년 또는 3년).' });
  }

  const scopeId = scopeIdForUser(owner);
  const seats = seatCountForScope(scopeId);
  const amount = termYears ? subscriptionTermAmount(seats, termYears) : seats * SUBSCRIPTION_PRICE_PER_SEAT_KRW;

  // [추가] 계정당 최초 1회만 무료 체험(월 구독 전용): 체험 기간에는 즉시 결제하지 않고, 체험이 끝나는 날
  // 정기결제 작업이 자동으로 첫 결제를 한다. 기간 약정은 체험 없이 바로 결제한다.
  const useTrial = !termYears && !owner.trialUsed;
  try {
    if (!useTrial) {
      await chargeBilling(TOSS_SECRET_KEY, owner.tossBillingKey, {
        customerKey: owner.tossCustomerKey,
        amount,
        orderId: generateOrderId(),
        orderName: `BizCard 구독 (좌석 ${seats}개)`,
        customerEmail: owner.email,
        customerName: owner.name
      });
    }

    owner.plan = 'pro';
    owner.subscriptionStatus = 'active';
    owner.trialUsed = true;
    // [추가] 이 사람이 추천인으로서 이미 받아뒀지만 아직 반영 못 한 무료 개월(구독을
    // 시작하기 전이라 반영할 결제일이 없었던 경우)이 있으면, 첫 결제일을 잡을 때 한꺼번에 더해준다.
    let firstBillingDate = termYears
      ? addMonthsN(new Date(), 12 * termYears)
      : useTrial
        ? new Date(Date.now() + SUBSCRIPTION_TRIAL_DAYS * 24 * 60 * 60 * 1000)
        : addOneMonth(new Date());
    owner.billingTermYears = termYears || undefined;
    const pendingCredit = owner.referralCreditMonths || 0;
    for (let i = 0; i < pendingCredit; i++) firstBillingDate = addOneMonth(firstBillingDate);
    owner.nextBillingAt = firstBillingDate.toISOString();
    owner.referralCreditMonths = 0;
    await addUser(owner);
    await logAudit({
      scopeId,
      actorUserId: owner.id,
      actorEmail: owner.email,
      action: 'subscription_started',
      detail: { seats, amount }
    });

    // [추가] 친구 추천으로 가입한 사람이 지금 "처음으로" 구독 결제를 완료한 순간이면,
    // 본인(피추천인)과 추천인 양쪽에 무료 1개월씩 지급한다. referralRewardGranted로
    // 한 번만 지급되도록 막는다(나중에 해지 후 재구독해도 중복 지급되지 않는다).
    if (owner.referredByUserId && !owner.referralRewardGranted) {
      owner.referralRewardGranted = true;
      // 방금 잡은 다음 결제일을 한 달 더 미뤄서, 피추천인의 2번째 달을 무료로 만든다.
      owner.nextBillingAt = addOneMonth(new Date(owner.nextBillingAt)).toISOString();
      await addUser(owner);

      const referrer = users.find(u => u.id === owner.referredByUserId);
      if (referrer) {
        await applyReferralCreditMonths(referrer, 1);
        await logAudit({
          scopeId: scopeIdForUser(referrer),
          actorUserId: owner.id,
          actorEmail: owner.email,
          action: 'referral_rewarded',
          targetUserId: referrer.id,
          targetEmail: referrer.email,
          detail: { rewardMonths: 1 }
        });
      }
      await markReferralRewarded(owner.id);
    }

    res.json({ success: true, plan: owner.plan, nextBillingAt: owner.nextBillingAt, amount: useTrial ? 0 : amount, trial: useTrial });
  } catch (err: unknown) {
    console.error('구독 결제 실패:', err);
    res.status(400).json({ error: getErrorMessage(err) || '결제에 실패했습니다.' });
  }
});

// 구독 해지: 지금 당장 기능을 끊지 않고, 이미 결제한 이번 결제 주기가 끝날 때까지는 pro를 유지한다
// (일반적인 구독 서비스 관례 — 이미 낸 돈만큼은 계속 쓸 수 있게).
app.post('/api/billing/cancel', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const owner = billingOwnerForRequester(requester);
  if (!owner) return res.status(403).json({ error: '회사 계정은 관리자만 구독을 관리할 수 있습니다.' });
  if (owner.subscriptionStatus !== 'active') {
    return res.status(400).json({ error: '진행 중인 구독이 없습니다.' });
  }

  owner.subscriptionStatus = 'canceled';
  await addUser(owner);
  await logAudit({
    scopeId: scopeIdForUser(owner),
    actorUserId: owner.id,
    actorEmail: owner.email,
    action: 'subscription_canceled'
  });

  res.json({ success: true, message: `구독이 해지되었습니다. ${owner.nextBillingAt ? new Date(owner.nextBillingAt).toLocaleDateString('ko-KR') + '까지는 계속 이용하실 수 있어요.' : ''}` });
});

// 현재 구독 상태 조회 — 회사 계정이면 일반 사용자도 "우리 회사가 pro인지"는 볼 수 있어야 하므로
// role 제한 없이 조회 가능하게 하되, 결제 자체(등록/구독/해지)는 admin만 가능하다.
app.get('/api/billing/status', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const scopeId = scopeIdForUser(requester);
  const owner = requester.type === 'individual'
    ? requester
    : users.find(u => scopeIdForUser(u) === scopeId && u.role === 'admin');

  const seats = seatCountForScope(scopeId);
  res.json({
    plan: owner?.plan || 'free',
    subscriptionStatus: owner?.subscriptionStatus || 'none',
    nextBillingAt: owner?.nextBillingAt || null,
    hasCardRegistered: Boolean(owner?.tossBillingKey),
    seats,
    pricePerSeat: SUBSCRIPTION_PRICE_PER_SEAT_KRW,
    estimatedMonthlyAmount: seats * SUBSCRIPTION_PRICE_PER_SEAT_KRW,
    // 결제 관리(카드 등록/구독/해지)를 이 사람이 할 수 있는지
    canManageBilling: Boolean(billingOwnerForRequester(requester))
  });
});

// [추가] 실제 매달 자동결제를 처리하는 함수. active 구독 중 결제일이 된 사람은 청구하고,
// canceled 상태에서 결제 주기가 끝난 사람은 free로 내린다.
// 이 서버 프로세스가 계속 켜져 있다는 전제로 아래에 주기적 인터벌도 걸어두지만, Render 무료
// 요금제처럼 서버가 잠들 수 있는 환경에서는 그 시간 동안 청구가 밀릴 수 있다. 더 안정적으로
// 하려면 외부 크론(예: cron-job.org, GitHub Actions 스케줄)이 아래 /api/billing/run-scheduled
// 엔드포인트를 매일 한 번씩 호출하도록 설정하는 걸 권장한다 (해당 라우트 주석 참고).
async function runScheduledBilling(): Promise<{ charged: number; failed: number; downgraded: number }> {
  const now = new Date();
  let charged = 0, failed = 0, downgraded = 0;

  for (const owner of [...users]) {
    if (owner.type === 'company' && owner.role !== 'admin') continue; // 관리자 계정만 결제 주체
    if (!owner.nextBillingAt) continue;
    if (new Date(owner.nextBillingAt) > now) continue;

    const scopeId = scopeIdForUser(owner);

    if (owner.subscriptionStatus === 'active') {
      if (!owner.tossBillingKey || !owner.tossCustomerKey || !TOSS_SECRET_KEY) continue;
      const seats = seatCountForScope(scopeId);
      const termYears = owner.billingTermYears || 0;
      const amount = termYears ? subscriptionTermAmount(seats, termYears) : seats * SUBSCRIPTION_PRICE_PER_SEAT_KRW;
      try {
        await chargeBilling(TOSS_SECRET_KEY, owner.tossBillingKey, {
          customerKey: owner.tossCustomerKey,
          amount,
          orderId: generateOrderId(),
          orderName: `BizCard 구독 갱신 (좌석 ${seats}개)`,
          customerEmail: owner.email,
          customerName: owner.name
        });
        owner.nextBillingAt = (termYears ? addMonthsN(now, 12 * termYears) : addOneMonth(now)).toISOString();
        await addUser(owner);
        await logAudit({ scopeId, actorUserId: owner.id, actorEmail: owner.email, action: 'subscription_renewed', detail: { seats, amount, termYears } });
        charged++;
      } catch (err) {
        console.error(`정기결제 실패 (${owner.email}):`, err);
        owner.subscriptionStatus = 'past_due';
        await addUser(owner);
        await logAudit({ scopeId, actorUserId: owner.id, actorEmail: owner.email, action: 'subscription_payment_failed' });
        failed++;
      }
    } else if (owner.subscriptionStatus === 'canceled') {
      owner.plan = 'free';
      owner.nextBillingAt = undefined;
      await addUser(owner);
      await logAudit({ scopeId, actorUserId: owner.id, actorEmail: owner.email, action: 'subscription_downgraded_to_free' });
      downgraded++;
    }
  }

  return { charged, failed, downgraded };
}

// 서버가 켜져 있는 동안, 1시간마다 결제일이 된 구독을 확인한다 (최소한의 자체 스케줄러).
setInterval(() => {
  runScheduledBilling().catch((err) => console.error('runScheduledBilling 실패:', err));
}, 60 * 60 * 1000);

// [추가] 외부 크론 서비스가 매일 호출할 수 있는 엔드포인트. 서버가 잠들었다 깨어나는 배포
// 환경에서도, 외부에서 이 주소를 정기적으로 때려주면 결제가 안정적으로 돌아간다.
// [수정] CRON_SECRET 환경변수는 이제 필수다. 이 라우트는 로그인 게이트를 우회하기 때문에,
// CRON_SECRET 없이는 "아무나 인증 없이 결제를 강제 실행"할 수 있는 심각한 보안 구멍이 생긴다.
app.post('/api/billing/run-scheduled', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되지 않았습니다. 운영자에게 문의하세요.' });
  }
  if (req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await runScheduledBilling();
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    res.status(500).json({ error: getErrorMessage(err) || '스케줄 처리 중 오류가 발생했습니다.' });
  }
});

// ------------------------------------------------------------------
// 🤖 회사 비즈니스 요약 자동 채우기 (매일, 무료 할당량 안에서)
// [추가] "AI 회사 비즈니스 요약" 버튼을 사용자가 직접 눌러야만 채워지던 걸, 아직 요약이
// 없는 회사들을 매일 자동으로 조금씩 채워주는 배치 작업으로 보완한다. Gemini 무료
// 할당량(하루 요청 수 제한)을 넘기지 않도록, 하루에 처리할 개수를 제한해서 실행한다.
// ------------------------------------------------------------------

// 하루에 자동으로 채워줄 회사 개수 상한. 쓰는 Gemini 모델의 무료 일일 할당량에 맞춰
// GEMINI_DAILY_SUMMARY_QUOTA 환경변수로 조절할 수 있다(기본값은 안전하게 보수적으로 잡음).
// [수정] 예전엔 기본값이 50이었는데, 실제 Gemini 무료 티어 하루 한도가 20회뿐이라 이
// 배치 작업 혼자서 하루 한도 전체(그 이상)를 다 써버릴 수 있었다. 그러면 정작 실시간으로
// 써야 하는 명함/영수증 스캔이나 사용자가 직접 누르는 "기업 인텔리전스" 검색 버튼에 쓸
// 할당량이 하나도 안 남는 문제가 있었다. 이 배치는 "여유가 있을 때 조금씩 채워주는"
// 보조 기능이니, 하루 한도의 일부(기본 3회)만 쓰도록 훨씬 보수적으로 낮췄다 — 대부분의
// 할당량은 실시간 사용자 액션을 위해 남겨둔다.
const DAILY_SUMMARY_QUOTA = Number(process.env.GEMINI_DAILY_SUMMARY_QUOTA) || 3;

async function runDailyCompanySummaryBatch(): Promise<{ scopesChecked: number; companiesUpdated: number; failed: number }> {
  if (!process.env.GEMINI_API_KEY) {
    console.log('[회사요약 자동배치] GEMINI_API_KEY가 없어 건너뜁니다.');
    return { scopesChecked: 0, companiesUpdated: 0, failed: 0 };
  }

  const scopeStats = await getPlatformStats();
  // [수정] 최근에 활동이 있었던(=명함이 최근에 추가/수정된) 스코프부터 먼저 처리한다.
  // 하루 할당량이 부족해서 다 못 돌더라도, 최근에 활발히 쓰는 회사가 우선적으로 채워지게 하기 위함.
  const sortedScopes = scopeStats
    .filter((s) => s.scopeId.startsWith('company:') || s.scopeId.startsWith('individual:'))
    .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));

  let quotaRemaining = DAILY_SUMMARY_QUOTA;
  let companiesUpdated = 0;
  let failed = 0;
  let scopesChecked = 0;
  // [추가] Gemini 쪽 할당량 자체가 완전히 소진된 경우(429 RESOURCE_EXHAUSTED), 남은 회사를
  // 계속 돌아봐야 전부 똑같이 실패할 뿐이다. 이걸 감지하면 남은 스코프/회사를 다 뒤지지
  // 않고 이번 배치를 즉시 멈춰서, 서버 로그가 똑같은 실패로 도배되고 시간을 낭비하는 걸
  // 막는다(다음 실행 때 다시 시도하면 됨 — 하루 지나면 할당량이 초기화되니까).
  let quotaExhaustedByGemini = false;

  for (const scope of sortedScopes) {
    if (quotaRemaining <= 0 || quotaExhaustedByGemini) break;
    scopesChecked++;

    const contacts = await getScopedCollection<BusinessCard>(scope.scopeId, 'contacts');
    // 회사명은 있는데 요약이 아직 없는 명함들을, 회사명 기준으로 묶는다(같은 회사 명함
    // 여러 장이 있어도 그 회사는 한 번만 검색하고 전부에 같이 적용하기 위함).
    const byCompany = new Map<string, BusinessCard[]>();
    for (const c of contacts) {
      const company = (c.company || '').trim();
      if (!company || c.companyInfo) continue;
      if (!byCompany.has(company)) byCompany.set(company, []);
      byCompany.get(company)!.push(c);
    }

    for (const [company, group] of byCompany) {
      if (quotaRemaining <= 0 || quotaExhaustedByGemini) break;
      try {
        const { summary: companyInfo, fromCache } = await getOrGenerateCompanySummary(company);
        // [수정] 전역 캐시에서 바로 가져온 경우(fromCache)는 실제로 Gemini를 호출한 게
        // 아니므로 하루 할당량을 깎지 않는다 — 캐시 재사용 자체가 이 배치의 핵심 목적이다.
        if (!fromCache) quotaRemaining--;
        for (const c of group) {
          c.companyInfo = companyInfo;
          await setScopedDoc(scope.scopeId, 'contacts', c);
        }
        companiesUpdated++;
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        if (getErrorField(err, 'status') === 429 || /RESOURCE_EXHAUSTED/i.test(msg)) {
          console.error(`[회사요약 자동배치] Gemini 할당량이 소진되어 이번 배치를 중단합니다 ("${company}"에서 감지).`);
          quotaExhaustedByGemini = true;
          break;
        }
        console.error(`[회사요약 자동배치] "${company}" 요약 실패:`, err);
        failed++;
        quotaRemaining--; // 실패도 API 호출 자체는 소비했을 수 있으니 할당량에서 뺀다
      }
    }

    // 메모리 캐시가 있다면 갱신된 내용을 다음 요청에서 다시 읽어오도록 비운다.
    delete db[scope.scopeId];
  }

  console.log(`[회사요약 자동배치] 완료: 스코프 ${scopesChecked}개 확인, 회사 ${companiesUpdated}곳 갱신, 실패 ${failed}건${quotaExhaustedByGemini ? ' (Gemini 할당량 소진으로 조기 종료)' : ''}`);
  return { scopesChecked, companiesUpdated, failed };
}

// 서버가 켜져 있는 동안, 1시간마다 "오늘 이미 실행했는지" 확인해서 하루에 한 번만 돈다.
let lastCompanySummaryRunDate: string | null = null;
setInterval(() => {
  const todayKey = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  if (lastCompanySummaryRunDate === todayKey) return;
  lastCompanySummaryRunDate = todayKey;
  runDailyCompanySummaryBatch().catch((err) => console.error('runDailyCompanySummaryBatch 실패:', err));
}, 60 * 60 * 1000);

// [추가] 서버가 잠들었다 깨어나는 배포 환경(Render 등)에서도 안정적으로 매일 한 번은
// 돌 수 있도록, 외부 크론 서비스가 정기적으로 호출할 수 있는 엔드포인트도 열어둔다.
// CRON_SECRET을 설정해두면 그 값을 아는 요청만 실행할 수 있다.
app.post('/api/admin/run-company-summary-batch', async (req, res) => {
  // [수정] 위 결제 크론과 같은 이유로, CRON_SECRET이 없으면 운영자 로그인 세션을 요구한다.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (req.headers['x-cron-secret'] !== cronSecret) return res.status(401).json({ error: 'unauthorized' });
  } else {
    const requesterId = req.headers['x-user-id'] as string;
    const requester = users.find(u => u.id === requesterId);
    if (!requester || requester.email !== ADMIN_EMAIL) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await runDailyCompanySummaryBatch();
    lastCompanySummaryRunDate = new Date().toISOString().slice(0, 10);
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    res.status(500).json({ error: getErrorMessage(err) || '배치 처리 중 오류가 발생했습니다.' });
  }
});

// ------------------------------------------------------------------
// 📊✉️ 일일 현황 리포트 + 자동 백업 이메일 (매일 아침, 스코프별로 관리자에게 발송)
// [추가] "정비 예정일 임박", "팔로우업 필요 프로젝트", "결재 대기 문서"를 화면을 직접 열어야만
// 확인할 수 있어서 놓치기 쉽다는 피드백에 따라, 매일 아침 이메일로 미리 알려주는 배치를
// 추가한다. 같은 메일에 그날 기준 전체 데이터 백업(JSON)도 함께 첨부해서, 자동 백업도 겸한다
// (그동안 "백업 내보내기"는 관리자가 직접 눌러야만 하는 수동 기능만 있었다).
// ------------------------------------------------------------------

// 한국 시간(KST) 기준 "오늘" 날짜 문자열(YYYY-MM-DD). 서버 자체는 보통 UTC로 돌아가므로,
// "매일 아침 7시"처럼 한국 사용자 기준 시각을 판단하려면 이 함수로 통일해서 써야 한다.
function getTodayKstStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

// 한국 시간(KST) 기준 현재 "시(0~23)". Intl의 hour12 옵션은 자정에 "24"를 반환하는 알려진
// 함정이 있어서, hourCycle: 'h23'을 명시해 0~23 범위로만 나오게 한다.
function getCurrentKstHour(): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === 'hour');
  return hourPart ? Number(hourPart.value) : new Date().getUTCHours();
}

// 프로젝트의 "마지막 활동(최근 미팅 또는 생성일)으로부터 경과일"을 계산한다.
// ProjectsView.tsx의 getDaysSinceLastActivity와 동일한 로직을 서버에서도 써야 해서 그대로 옮겨왔다
// (다만 "오늘"은 접속한 브라우저 시각이 아니라 서버가 판단하는 KST 기준 오늘로 고정한다).
function getProjectDaysSinceLastActivity(proj: Project, todayStr: string): number {
  let lastDateStr = proj.createdAt ? proj.createdAt.split('T')[0] : todayStr;
  if (proj.followUps && proj.followUps.length > 0) {
    let maxDateStr = proj.followUps[0].date;
    for (const f of proj.followUps) {
      if (f.date > maxDateStr) maxDateStr = f.date;
    }
    lastDateStr = maxDateStr.split('T')[0];
  }
  const parseLocalDate = (str: string) => {
    const parts = str.split('-');
    if (parts.length === 3) return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).getTime();
    return new Date(str).getTime();
  };
  const diffDays = Math.floor((parseLocalDate(todayStr) - parseLocalDate(lastDateStr)) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 ? diffDays : 0;
}

// 7일 이내로 임박한 "예정" 정비 건을 날짜 가까운 순으로 뽑는다.
function findUpcomingMaintenance(dbData: typeof db[string], todayStr: string, withinDays = 7): VehicleMaintenance[] {
  const todayMs = new Date(todayStr).getTime();
  return (dbData.maintenances || [])
    .filter((m) => {
      if (m.status !== 'scheduled') return false;
      const diffDays = Math.round((new Date(m.date).getTime() - todayMs) / (1000 * 60 * 60 * 24));
      return diffDays >= 0 && diffDays <= withinDays;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// 화면의 "팔로우업 필요" 배너와 동일한 기준(활성 상태 + 5일 이상 연락 없음)으로, 경과일이 긴
// 순(가장 급한 순)으로 뽑는다.
function findNeedyProjects(dbData: typeof db[string], todayStr: string): Project[] {
  return (dbData.projects || [])
    .filter((p) => {
      if (p.status !== 'opportunity' && p.status !== 'progress') return false;
      return getProjectDaysSinceLastActivity(p, todayStr) >= 5;
    })
    .sort((a, b) => getProjectDaysSinceLastActivity(b, todayStr) - getProjectDaysSinceLastActivity(a, todayStr));
}

// 휴가신청서/가지급금 정산서/공문서 중 결재 대기(status === 'pending') 중인 문서를 모아서,
// 결재선(approvalLine)에서 아직 날짜가 안 찍힌(=미결) 첫 단계가 누구인지와 함께 반환한다.
function findPendingApprovals(dbData: typeof db[string]): { label: string; waitingOn: string }[] {
  const results: { label: string; waitingOn: string }[] = [];
  const pickWaiting = (steps: ApprovalStep[] | undefined) => {
    const step = (steps || []).find((s) => !s.date);
    return step ? (step.name || step.role || '담당자') : '담당자';
  };
  for (const lr of dbData.leaveRequests || []) {
    if (lr.status !== 'pending') continue;
    results.push({ label: `휴가 신청서 (${lr.author})`, waitingOn: pickWaiting(lr.approvalLine) });
  }
  for (const ap of dbData.advancePayments || []) {
    if (ap.status !== 'pending') continue;
    results.push({ label: `가지급금 정산서 (${ap.author})`, waitingOn: pickWaiting(ap.approvalLine) });
  }
  for (const od of dbData.officialDocuments || []) {
    if (od.status !== 'pending') continue;
    results.push({ label: `공문서: ${od.subject}`, waitingOn: pickWaiting(od.approvalLine) });
  }
  return results;
}

// 스코프(회사/개인)별로 이 리포트 메일을 받을 사람을 정한다. 회사 계정은 관리자에게(가입
// 승인 대기 중인 사람은 제외), 관리자가 한 명도 없으면(이례적) 아무 구성원에게라도 보낸다.
// 개인 계정은 role이 없으므로 자연스럽게 본인에게 보내진다.
function getReportRecipients(scopeId: string): RegisteredUser[] {
  const members = users.filter((u) => scopeIdForUser(u) === scopeId && u.approvalStatus !== 'pending');
  if (members.length === 0) return [];
  const admins = members.filter((u) => u.role === 'admin');
  return admins.length > 0 ? admins : members.slice(0, 1);
}

const MAX_BACKUP_ATTACHMENT_BYTES = 8 * 1024 * 1024; // Brevo 첨부 용량에 여유를 두고 8MB로 제한

function buildDailyReportEmailHtml(opts: {
  dateStr: string;
  upcomingMaint: VehicleMaintenance[];
  needyProjects: Project[];
  pendingApprovals: { label: string; waitingOn: string }[];
  backupAttached: boolean;
}): string {
  const maxRows = 10;
  const renderList = (items: string[]) =>
    items.length > 0
      ? `<ul style="margin:4px 0; padding-left:20px; font-size:13px; line-height:1.7; color:#333;">${items
          .slice(0, maxRows)
          .map((i) => `<li>${i}</li>`)
          .join('')}${items.length > maxRows ? `<li style="color:#888;">...외 ${items.length - maxRows}건 더</li>` : ''}</ul>`
      : `<p style="font-size:13px; color:#aaa; margin:4px 0 0;">해당 없음</p>`;

  const maintItems = opts.upcomingMaint.map(
    (m) => `${escapeHtml(m.date)} - ${escapeHtml(m.title)}${m.mileage ? ` (예상 시점 ${m.mileage.toLocaleString()}km)` : ''}`
  );
  const projectItems = opts.needyProjects.map((p) => escapeHtml(p.name));
  const approvalItems = opts.pendingApprovals.map((a) => `${escapeHtml(a.label)} - <b>${escapeHtml(a.waitingOn)}</b>님 결재 대기중`);

  return `
    <div style="font-family: 'Malgun Gothic', sans-serif; padding: 24px; color:#111; max-width:600px;">
      <h2 style="margin-bottom:4px;">📋 ${opts.dateStr} BizCard 일일 현황</h2>
      <p style="color:#555; font-size:13px;">${
        opts.backupAttached
          ? '아래 항목들을 확인해 보세요. 이 메일에는 오늘 기준 전체 데이터 백업 파일(JSON)도 첨부되어 있습니다.'
          : '아래 항목들을 확인해 보세요. (오늘은 데이터 양이 많아 백업 파일 첨부를 건너뛰었습니다 - 필요하시면 관리자 화면의 "백업 내보내기"로 직접 받아주세요.)'
      }</p>

      <h3 style="margin-top:20px; margin-bottom:4px; font-size:15px;">🔧 임박한 예정 정비 (7일 이내)</h3>
      ${renderList(maintItems)}

      <h3 style="margin-top:20px; margin-bottom:4px; font-size:15px;">⚠️ 팔로우업 필요 프로젝트 (5일 이상 연락 없음)</h3>
      ${renderList(projectItems)}

      <h3 style="margin-top:20px; margin-bottom:4px; font-size:15px;">📝 결재 대기중인 문서</h3>
      ${renderList(approvalItems)}

      <a href="${APP_BASE_URL}" style="display:inline-block; margin-top:24px; padding:10px 22px; background:#4f46e5; color:#fff; text-decoration:none; border-radius:8px; font-weight:bold;">사이트에서 확인하기</a>
    </div>
  `;
}

async function runDailyReportAndBackupBatch(): Promise<{ scopesChecked: number; emailsSent: number; failed: number }> {
  if (!isMailerConfigured) {
    console.log('[일일 리포트+백업] 메일 설정이 안 되어 있어 건너뜁니다.');
    return { scopesChecked: 0, emailsSent: 0, failed: 0 };
  }

  const todayStr = getTodayKstStr();
  const scopeStats = await getPlatformStats();
  const relevantScopes = scopeStats.filter(
    (s) => (s.scopeId.startsWith('company:') || s.scopeId.startsWith('individual:')) && s.totalItems > 0
  );

  let emailsSent = 0;
  let failed = 0;

  for (const scope of relevantScopes) {
    try {
      const recipients = getReportRecipients(scope.scopeId);
      if (recipients.length === 0) continue;

      const dbData = await loadScopeFromSupabase(scope.scopeId);
      const upcomingMaint = findUpcomingMaintenance(dbData, todayStr);
      const needyProjects = findNeedyProjects(dbData, todayStr);
      const pendingApprovals = findPendingApprovals(dbData);

      const backupJson = JSON.stringify(
        { exportedAt: new Date().toISOString(), scope: { scopeId: scope.scopeId }, data: buildBackupDataPayload(dbData) },
        null,
        2
      );
      const backupBuffer = Buffer.from(backupJson, 'utf-8');
      const backupAttached = backupBuffer.byteLength <= MAX_BACKUP_ATTACHMENT_BYTES;

      const html = buildDailyReportEmailHtml({ dateStr: todayStr, upcomingMaint, needyProjects, pendingApprovals, backupAttached });

      for (const recipient of recipients) {
        try {
          await sendEmail({
            to: recipient.email,
            toName: recipient.name,
            subject: `[BizCard] ${todayStr} 일일 현황 + 자동 백업`,
            html,
            attachments: backupAttached ? [{ filename: `bizcard-backup-${todayStr}.json`, content: backupBuffer }] : undefined
          });
          emailsSent++;
        } catch (err) {
          failed++;
          console.error(`[일일 리포트+백업] ${recipient.email}에게 발송 실패:`, err);
        }
      }
    } catch (err) {
      failed++;
      console.error(`[일일 리포트+백업] 스코프 ${scope.scopeId} 처리 실패:`, err);
    }
  }

  console.log(`[일일 리포트+백업] 완료: 스코프 ${relevantScopes.length}개 확인, 이메일 ${emailsSent}건 발송, 실패 ${failed}건`);
  return { scopesChecked: relevantScopes.length, emailsSent, failed };
}

// 매일 아침 7시(KST) 무렵에 한 번만 발송한다. 시간 판단은 위 회사요약 배치와 동일하게
// "한 시간마다 확인해서, 목표 시각을 지났고 오늘 아직 안 돌았으면 실행" 방식을 쓰되, 여기서는
// KST 날짜/시각 기준으로 판단한다(그래야 한국 사용자에게 실제로 "아침"에 도착한다).
const DAILY_REPORT_TARGET_KST_HOUR = 7;
let lastDailyReportRunDate: string | null = null;
setInterval(() => {
  const todayKey = getTodayKstStr();
  if (lastDailyReportRunDate === todayKey) return;
  if (getCurrentKstHour() < DAILY_REPORT_TARGET_KST_HOUR) return;
  lastDailyReportRunDate = todayKey;
  runDailyReportAndBackupBatch().catch((err) => console.error('runDailyReportAndBackupBatch 실패:', err));
}, 60 * 60 * 1000);

// [추가] 위 회사요약 배치와 동일한 이유로, 서버가 잠들었다 깨어나는 배포 환경에서도 외부
// 크론 서비스가 이 주소를 매일 아침(KST 7시 이후) 한 번 호출해주면 안정적으로 돌아간다.
app.post('/api/admin/run-daily-report-batch', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (req.headers['x-cron-secret'] !== cronSecret) return res.status(401).json({ error: 'unauthorized' });
  } else {
    const requesterId = req.headers['x-user-id'] as string;
    const requester = users.find((u) => u.id === requesterId);
    if (!requester || requester.email !== ADMIN_EMAIL) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await runDailyReportAndBackupBatch();
    lastDailyReportRunDate = getTodayKstStr();
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    res.status(500).json({ error: getErrorMessage(err) || '일일 리포트 처리 중 오류가 발생했습니다.' });
  }
});

// ------------------------------------------------------------------
// 🚧 회사 가입 승인 관리 (관리자 전용)
// [추가] 같은 회사(사업자번호)로 새로 가입한 사람은 관리자가 승인해야 실제로
// 회사 데이터(명함/프로젝트 등)에 접근할 수 있다. 아래 3개 API로 그 승인 절차를 관리한다.
// ------------------------------------------------------------------

// 우리 회사의 승인 대기 중인 가입 신청자 목록
app.get('/api/auth/pending-members', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: '관리자만 조회할 수 있습니다.' });

  const pending = users.filter(u =>
    u.type === 'company' &&
    u.approvalStatus === 'pending' &&
    scopeIdForUser(u) === scopeIdForUser(requester)
  );
  res.json(pending.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    position: u.position,
    createdAt: u.createdAt
  })));
});

// 가입 승인: 이때부터 그 사람이 우리 회사 데이터에 접근할 수 있게 된다
app.post('/api/auth/pending-members/:targetId/approve', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: '관리자만 승인할 수 있습니다.' });

  const target = users.find(u => u.id === req.params.targetId);
  if (!target) return res.status(404).json({ error: '대상 사용자를 찾을 수 없습니다.' });
  if (scopeIdForUser(requester) !== scopeIdForUser(target)) {
    return res.status(403).json({ error: '같은 회사 소속 신청자만 승인할 수 있습니다.' });
  }

  target.approvalStatus = 'approved';
  await addUser(target);
  await logAudit({
    scopeId: scopeIdForUser(requester),
    actorUserId: requester.id,
    actorEmail: requester.email,
    action: 'member_approve',
    targetUserId: target.id,
    targetEmail: target.email
  });
  res.json({ success: true });
});

// 가입 거절: 그 신청 자체를 계정과 함께 삭제한다 (거절된 사람은 같은 이메일로 재가입 가능)
app.post('/api/auth/pending-members/:targetId/reject', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (requester.role !== 'admin') return res.status(403).json({ error: '관리자만 거절할 수 있습니다.' });

  const target = users.find(u => u.id === req.params.targetId);
  if (!target) return res.status(404).json({ error: '대상 사용자를 찾을 수 없습니다.' });
  if (scopeIdForUser(requester) !== scopeIdForUser(target)) {
    return res.status(403).json({ error: '같은 회사 소속 신청자만 거절할 수 있습니다.' });
  }
  if (target.approvalStatus !== 'pending') {
    return res.status(400).json({ error: '이미 처리된 신청입니다.' });
  }

  // [수정] 계정을 지우기 전에 감사 로그부터 남긴다 (지운 뒤에는 대상 이메일 등 정보가 사라짐).
  await logAudit({
    scopeId: scopeIdForUser(requester),
    actorUserId: requester.id,
    actorEmail: requester.email,
    action: 'member_reject',
    targetUserId: target.id,
    targetEmail: target.email
  });

  users = users.filter(u => u.id !== target.id);
  await deleteUser(target.id);
  await invalidateAllSessionsForUser(target.id); // 혹시 로그인돼 있었다면 세션도 끊는다
  res.json({ success: true });
});

// [추가] 관리자가 같은 회사 동료의 이메일 인증을 수동으로 처리한다. Daum/Naver 같은
// 국내 메일이 해외 발송 서버(Brevo)의 인증 메일을 "anti-spam system"으로 자동 차단해서
// (실제로 Brevo 발송 로그에 "554 5.7.1 ... blocked automatically by anti-spam system"
// 형태로 반려되는 사례를 확인함) 정상적으로 가입했는데도 인증 메일 자체를 못 받아
// 계속 막혀 있는 경우가 있다. 이럴 때 관리자가 "본인 확인 후" 여기서 직접 인증
// 완료 처리를 해줄 수 있게 한다. 승인 대기(approvalStatus)와는 별개의 잠금이라 따로 둔다.
// [수정] 개발자(운영자, ADMIN_EMAIL) 계정은 어느 회사 소속 admin이 아니어도(혹은 그
// 회사에 아직 승인된 admin이 아무도 없어도) 회사 구분 없이 이 기능을 쓸 수 있어야
// 고객사 문의 대응이 가능하다 — /api/auth/users의 "운영자는 전체 조회 가능" 예외와 동일한 취지.
app.post('/api/auth/users/:targetId/verify-email', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const isOperator = requester.email === ADMIN_EMAIL;
  if (requester.role !== 'admin' && !isOperator) return res.status(403).json({ error: '관리자만 처리할 수 있습니다.' });

  const target = users.find(u => u.id === req.params.targetId);
  if (!target) return res.status(404).json({ error: '대상 사용자를 찾을 수 없습니다.' });
  if (!isOperator && scopeIdForUser(requester) !== scopeIdForUser(target)) {
    return res.status(403).json({ error: '같은 회사 소속 회원만 처리할 수 있습니다.' });
  }
  if (isEmailVerified(target.emailVerified)) {
    return res.status(400).json({ error: '이미 인증된 계정입니다.' });
  }

  target.emailVerified = true;
  await addUser(target);
  await logAudit({
    scopeId: scopeIdForUser(requester),
    actorUserId: requester.id,
    actorEmail: requester.email,
    action: 'member_manual_email_verify',
    targetUserId: target.id,
    targetEmail: target.email
  });
  res.json({ success: true });
});

// [추가] 관리자(또는 개발자/운영자 계정)가 동료의 비밀번호를 직접 새로 정해준다. 비밀번호는
// bcrypt로 단방향 암호화해서 저장하기 때문에 "원래 비밀번호가 뭐였는지"는 개발자도
// 절대 알아낼 수 없는데, 국내 메일(Daum/Naver)이 해외 발송 서버의 메일을 자동 차단해서
// 비밀번호 재설정 메일 자체가 안 가는 경우가 있어, 이메일에 전혀 의존하지 않고 관리자가
// 직접 새 비밀번호를 정해서 알려줄 수 있는 우회 경로를 만든다.
app.post('/api/auth/users/:targetId/set-password', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });
  const isOperator = requester.email === ADMIN_EMAIL;
  if (requester.role !== 'admin' && !isOperator) return res.status(403).json({ error: '관리자만 처리할 수 있습니다.' });

  const target = users.find(u => u.id === req.params.targetId);
  if (!target) return res.status(404).json({ error: '대상 사용자를 찾을 수 없습니다.' });
  if (!isOperator && scopeIdForUser(requester) !== scopeIdForUser(target)) {
    return res.status(403).json({ error: '같은 회사 소속 회원만 처리할 수 있습니다.' });
  }
  // 본인 비밀번호는 이 기능이 아니라 평소 로그인 상태에서 "비밀번호 변경" 메뉴로 바꿔야 한다.
  if (target.id === requester.id) {
    return res.status(400).json({ error: '본인 비밀번호는 이 기능으로 바꿀 수 없습니다.' });
  }

  const { newPassword } = req.body;
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  }

  target.password = bcrypt.hashSync(String(newPassword), 10);
  await addUser(target);
  // 비밀번호가 바뀌었으니, 혹시 남아있던 이전 로그인 세션은 전부 끊는다 (reset-password와 동일).
  await invalidateAllSessionsForUser(target.id);
  await logAudit({
    scopeId: scopeIdForUser(requester),
    actorUserId: requester.id,
    actorEmail: requester.email,
    action: 'admin_set_password',
    targetUserId: target.id,
    targetEmail: target.email
  });
  res.json({ success: true });
});

// [추가] 업무일지 캘린더에서 "동료 초대" 대상을 고를 때 쓰는, 같은 회사 소속 동료 목록.
// 가입 승인이 아직 안 끝난(pending) 사람은 제외하고, 요청한 본인도 목록에서 뺀다.
app.get('/api/company-members', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const scopeId = scopeIdForUser(requester);
  const members = users.filter(u =>
    u.id !== requester.id &&
    scopeIdForUser(u) === scopeId &&
    u.approvalStatus !== 'pending'
  );
  res.json(members.map(u => ({ id: u.id, name: u.name, position: u.position || '', email: u.email })));
});

// 📁 Scoped CRUD APIs
// [추가] 예전 가짜 좌표 배정 방식으로 이미 저장된 기존 명함들을 실제 좌표로 다시 계산한다.
// 주소가 있는 명함만 대상으로, 몇 개씩 동시에 처리해서 너무 느려지지 않게 한다.
// [추가] 운행기록의 "목적지"를 입력할 때, 명함에 없는 곳(처음 방문하는 거래처 등)은
// 카카오 키워드 검색으로 실제 장소를 찾아서 골라 쓸 수 있게 한다. 상위 5개까지만
// 후보로 보여준다.
app.get('/api/places/search', async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 100);
  if (!query) return res.json({ places: [] });
  if (!KAKAO_REST_API_KEY) {
    return res.status(500).json({ error: 'KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.', places: [] });
  }

  try {
    const kakaoRes = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=5`, {
      headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` }
    });
    if (!kakaoRes.ok) {
      const bodyText = await kakaoRes.text().catch(() => '');
      return res.status(kakaoRes.status).json({ error: `카카오 장소 검색 오류: ${bodyText.slice(0, 200)}`, places: [] });
    }
    const data: KakaoLocalResponse = await kakaoRes.json();
    const places = (data.documents || []).map((d) => ({
      name: d.place_name,
      address: d.road_address_name || d.address_name,
      lat: parseFloat(d.y),
      lng: parseFloat(d.x)
    }));
    res.json({ places });
  } catch (err: unknown) {
    console.error('장소 검색 중 오류:', err);
    res.status(500).json({ error: getErrorMessage(err) || '장소 검색 중 오류가 발생했습니다.', places: [] });
  }
});

// [추가] 출발지/도착지 주소 두 개를 받아서 "직선거리 기준 예상 주행거리"를 계산해준다.
// 실제 도로 경로 거리(카카오 모빌리티 길찾기 API)를 쓰면 더 정확하겠지만, 그건 별도
// 상품 계약이 필요한 경우가 많아서, 대신 직선거리에 "왕복/우회를 감안한 보정 계수"를
// 곱해 근사치를 낸다. 어디까지나 "제안값"이라, 화면에서 사용자가 실제 계기판 값으로
// 언제든 직접 고칠 수 있다.
const ROAD_DISTANCE_CORRECTION_FACTOR = 1.3;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.post('/api/vehicles/estimate-distance', async (req, res) => {
  const { startAddress, endAddress, startLat, startLng, endLat, endLng } = req.body;

  try {
    // 좌표가 이미 넘어왔으면(예: 명함에 저장된 좌표) 그걸 쓰고, 없으면 주소로 새로 지오코딩한다.
    let sLat = startLat, sLng = startLng, eLat = endLat, eLng = endLng;

    // [수정] 예전엔 geocodeAddress()의 결과(성공/실패)만 보고 "좌표를 찾지 못했습니다"라는
    // 뭉뚱그린 메시지만 보여줬다. 실제로는 API 키 문제, 100자 초과, 검색 결과 없음 등
    // 원인이 다양한데 구분이 안 돼서, 화면만 봐서는 뭘 고쳐야 할지 알 수 없었다. 이제는
    // 실제 실패 사유(geocodeAddressWithDiagnostics가 주는 상세 메시지)를 그대로 보여준다.
    if (!sLat || !sLng) {
      const { coords, error } = await geocodeAddressWithDiagnostics(startAddress || '');
      if (!coords) return res.status(422).json({ error: `출발지 주소의 좌표를 찾지 못했습니다. (${error || '알 수 없는 이유'})` });
      sLat = coords.lat;
      sLng = coords.lng;
    }
    if (!eLat || !eLng) {
      const { coords, error } = await geocodeAddressWithDiagnostics(endAddress || '');
      if (!coords) return res.status(422).json({ error: `목적지 주소의 좌표를 찾지 못했습니다. (${error || '알 수 없는 이유'})` });
      eLat = coords.lat;
      eLng = coords.lng;
    }

    const straightLineKm = haversineKm(sLat, sLng, eLat, eLng);
    const estimatedRoadKm = Math.round(straightLineKm * ROAD_DISTANCE_CORRECTION_FACTOR * 10) / 10;

    res.json({ success: true, estimatedKm: estimatedRoadKm, straightLineKm: Math.round(straightLineKm * 10) / 10 });
  } catch (err: unknown) {
    console.error('예상 거리 계산 중 오류:', err);
    res.status(500).json({ error: getErrorMessage(err) || '거리 계산 중 오류가 발생했습니다.' });
  }
});

// [추가] 주소는 있는데 좌표를 못 구한 명함들을 목록으로 확인할 수 있게 한다. "실패 356건"
// 처럼 숫자만 보여주던 걸, 실제로 어떤 명함들인지(이름/회사/주소) 볼 수 있게 해서 어떤
// 패턴으로 실패하는지 파악하고 필요하면 주소를 직접 고칠 수 있게 하기 위함이다.
app.get('/api/contacts/geocode-failures', (req, res) => {
  const dbData = getScopedData(req);
  const failures = dbData.contacts
    .filter(c => (c.address || '').trim() && c.isRealGeocoded && (!c.lat || !c.lng))
    .map(c => ({ id: c.id, name: c.name, company: c.company, address: c.address }));
  res.json({ failures, count: failures.length });
});

app.post('/api/contacts/regeocode', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;

  // [수정] 예전엔 "아직 처리 안 된 것"을 매번 다시 필터링해서 판단했는데, retryFailed
  // 모드(주소 있는 것 전부 대상)에서는 이 필터가 "이미 처리했는지"를 구분 못 해서, 몇
  // 번을 호출해도 "남은 개수"가 전혀 줄지 않아 클라이언트가 끝없이 반복 호출하는
  // 심각한 버그가 있었다(실제로 명함 1,326개인데 5,700건 넘게 처리된 것으로 잘못
  // 집계된 사례가 있었다). 이제는 "몇 번째까지 처리했는지"(offset)를 클라이언트가
  // 명시적으로 넘겨주고, 서버는 그 위치부터 딱 LIMIT_PER_CALL개만 처리한 뒤 다음
  // 시작 위치를 알려주는 방식으로 바꿨다 — 전체 개수 대비 진행 위치로만 판단하니
  // 무한반복이 구조적으로 불가능하다.
  const retryFailed = req.body?.retryFailed === true;
  const offset = Number(req.body?.offset) || 0;

  const hasAddress = (c: BusinessCard) => Boolean((c.address || '').trim());
  const candidates = retryFailed
    ? dbData.contacts.filter(hasAddress)
    : dbData.contacts.filter((c) => hasAddress(c) && !c.isRealGeocoded);

  const LIMIT_PER_CALL = 150;
  const targets = candidates.slice(offset, offset + LIMIT_PER_CALL);

  let updated = 0;
  let failed = 0;
  let firstError: string | undefined;
  let authError = false;
  const CONCURRENCY = 6;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    // [추가] API 키 자체가 잘못됐다면(401/403) 이 명함 저 명함 할 것 없이 전부 똑같이
    // 실패한다. 이 경우 더 처리해봐야 의미가 없으니, 감지되면 이번 호출은 즉시 멈추고
    // 클라이언트에게 "이건 설정 문제니 재시도해도 소용없다"고 알린다.
    if (authError) break;

    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      const { coords, error } = await geocodeAddressWithDiagnostics(c.address || '');
      if (coords) {
        c.lat = coords.lat;
        c.lng = coords.lng;
        c.isRealGeocoded = true;
        await setScopedDoc(scopeId, 'contacts', c);
        updated++;
      } else {
        // [수정] 실패로 확정되면 예전 가짜 좌표가 남아있지 않도록 확실히 비운다.
        // "좌표 없음 = 진짜 지오코딩 실패"라는 걸 항상 믿을 수 있게 하기 위함이다.
        c.lat = undefined;
        c.lng = undefined;
        c.isRealGeocoded = true;
        await setScopedDoc(scopeId, 'contacts', c);
        failed++;
        if (!firstError && error) firstError = error;
        if (error && error.includes('인증 실패')) authError = true;
      }
    }));
  }

  // [수정] "이번 호출로 이 위치까지는 다 봤다"는 사실 하나만으로 다음 시작 위치와
  // 종료 여부를 정한다 — 목록 상태가 어떻게 바뀌든(성공/실패 관계없이) offset은
  // 항상 앞으로만 나아가므로 무한반복이 원천적으로 불가능하다.
  const nextOffset = offset + targets.length;
  const done = authError || nextOffset >= candidates.length;
  res.json({
    success: true,
    processedThisCall: targets.length,
    updated,
    failed,
    done,
    nextOffset,
    totalCandidates: candidates.length,
    firstError,
    authError
  });
});

// [추가] 명함 사진은 실제로는 Supabase Storage의 길고 복잡한 서명 URL(토큰 포함)에
// 저장돼 있다. 이 URL을 <img src>에 그대로 쓰면, iOS/Android에서 사진을 길게 눌렀을 때
// 뜨는 "저장/공유/복사" 메뉴 위에 저 긴 URL이 그대로 노출돼서 지저분해 보이는 문제가
// 있었다. 그래서 대신 우리 서버의 짧고 깔끔한 주소로 접근하게 하고, 서버가 실제
// Supabase 주소로 302 리다이렉트해준다 — 화면(브라우저)에 <img src>로 남는 값은 항상
// 이 짧은 주소이기 때문에, 길게 눌렀을 때 보이는 URL도 이 짧은 주소가 된다.
app.get('/api/img/contacts/:contactId/:side', (req, res) => {
  const dbData = getScopedData(req);
  const contact = dbData.contacts.find(c => c.id === req.params.contactId);
  if (!contact) return res.status(404).send('Not found');
  const url = req.params.side === 'back' ? contact.backImage : contact.frontImage;
  if (!url) return res.status(404).send('Not found');
  res.redirect(url);
});

app.get('/api/img/my-profile/:side', (req, res) => {
  const dbData = getScopedData(req);
  const url = req.params.side === 'back' ? dbData.myProfile?.backImage : dbData.myProfile?.frontImage;
  if (!url) return res.status(404).send('Not found');
  res.redirect(url);
});

app.get('/api/contacts', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);

  // Neon DB에서 사용자의 businessCards 데이터 직접 로드
  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const dbData = getScopedData(req);
  // DB에서 로드된 명함 및 그룹 추출
  const businessCards = dbData.contacts || [];
  const groups = dbData.groups || [];

  // [수정] "나만 보기(비공개)"로 설정된 명함은 등록한 본인 것만 내려주고, 다른 사람에게는 숨긴다.
  const privateGroupIds = new Set(
    groups.filter(g => g.isPrivate && g.createdByUserId && g.createdByUserId !== requesterId).map(g => g.id)
  );
  const visible = businessCards.filter(c => {
    if (c.isPrivate && c.addedByUserId && c.addedByUserId !== requesterId) return false;
    if (privateGroupIds.size > 0 && getContactGroupIds(c).some(gid => privateGroupIds.has(gid))) return false;
    return true;
  });
  res.json(visible);
});

app.post('/api/contacts', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const newCard: BusinessCard = req.body;
  if (!newCard.id) newCard.id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!newCard.createdAt) newCard.createdAt = new Date().toISOString();
  if (!newCard.callHistory) newCard.callHistory = [];

  // [추가] 매번 관리자가 "\" 정리 도구를 눌러줘야 하는 번거로움을 없애기 위해, 명함이
  // 저장되는 이 시점(신규 등록/수동 입력/스캔·OCR/가져오기 등 모든 경로가 결국 이 API로
  // 모인다)에 주소에 섞인 "\"를 자동으로 지운다. 그래서 이제부터는 애초에 "\"가 저장되는
  // 일 자체가 없다 - 관리자 도구는 이 변경 이전에 이미 저장돼 있던 기존 데이터를 한 번
  // 정리할 때만 필요하다.
  if (typeof newCard.address === 'string') newCard.address = stripBackslashFromAddress(newCard.address);
  if (typeof newCard.address2 === 'string') newCard.address2 = stripBackslashFromAddress(newCard.address2);
  if (typeof newCard.homeAddress === 'string') newCard.homeAddress = stripBackslashFromAddress(newCard.homeAddress);

  // [수정] 팀/부서별 공유(비공개) 기능을 위해 등록자 정보를 자동으로 남긴다.
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);
  newCard.addedByUserId = requesterId || newCard.addedByUserId;
  newCard.addedByUserName = requester?.name || newCard.addedByUserName;
  
  // 좌표가 없으면 실제 주소로 지오코딩해서 부여 (실패하면 좌표 없이 그대로 둠)
  if (!newCard.lat || !newCard.lng) {
    const coords = await geocodeAddress(newCard.address || '');
    if (coords) {
      newCard.lat = coords.lat;
      newCard.lng = coords.lng;
      newCard.isRealGeocoded = true;
    }
  }

  // [수정] 명함 사진을 DB에 base64로 통째로 넣지 않고 Storage에 업로드 후 URL만 저장
  newCard.frontImage = await persistImageField(scopeId, newCard.frontImage, `contact-${newCard.id}-front`);
  newCard.backImage = await persistImageField(scopeId, newCard.backImage, `contact-${newCard.id}-back`);
  
  dbData.contacts.unshift(newCard);
  // [수정] DB 저장이 실제로 실패했는데도 항상 "성공"으로 응답하던 문제를 고쳤다. 저장에
  // 실패하면 방금 메모리에 추가한 것도 되돌려서(롤백), 화면엔 저장된 것처럼 보이지만 DB엔
  // 없는 "유령 데이터" 상태가 생기지 않게 하고, 클라이언트에는 실패를 알려서 재시도하게 한다.
  const saved = await setScopedDoc(scopeId, 'contacts', newCard);
  if (!saved) {
    dbData.contacts = dbData.contacts.filter((c: BusinessCard) => c.id !== newCard.id);
    return res.status(500).json({ error: '명함을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(newCard);
});

app.put('/api/contacts/:id', async (req, res) => {
  // ✅ 데이터 수정 Rate Limiting
  if (!checkModifyRateLimit(req, res)) return;

  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const idx = dbData.contacts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Contact not found' });

  const beforeAddress = dbData.contacts[idx].address;
  // [추가] DB 저장이 실패했을 때 메모리 캐시를 원래대로 되돌리기(롤백) 위해 수정 전 값을 남겨둔다.
  const previousContact = dbData.contacts[idx];
  const updated = { ...dbData.contacts[idx], ...req.body };
  // [추가] POST와 동일하게, 수정 저장 시에도 주소에 섞인 "\"를 자동으로 지운다.
  if (typeof updated.address === 'string') updated.address = stripBackslashFromAddress(updated.address);
  if (typeof updated.address2 === 'string') updated.address2 = stripBackslashFromAddress(updated.address2);
  if (typeof updated.homeAddress === 'string') updated.homeAddress = stripBackslashFromAddress(updated.homeAddress);
  if (updated.address && updated.address !== beforeAddress) {
    const coords = await geocodeAddress(updated.address);
    if (coords) {
      updated.lat = coords.lat;
      updated.lng = coords.lng;
      updated.isRealGeocoded = true;
    }
  }

  // [수정] 재스캔 등으로 사진이 새로 바뀐 경우에만 업로드 (이미 URL이면 그대로 재사용, 불필요한 재업로드 방지)
  updated.frontImage = await persistImageField(scopeId, updated.frontImage, `contact-${updated.id}-front`);
  updated.backImage = await persistImageField(scopeId, updated.backImage, `contact-${updated.id}-back`);

  dbData.contacts[idx] = updated;
  // [수정] DB 저장이 실제로 실패했는데도 항상 "성공"으로 응답하던 문제를 고쳤다. 예전엔
  // setScopedDoc이 에러를 서버 콘솔에만 남기고 조용히 넘어가서, 재스캔한 명함 사진처럼
  // 방금 고친 내용이 화면엔 저장된 것처럼 보이지만 실제로는 메모리 캐시에만 반영되고
  // DB엔 없는 상태가 될 수 있었다(서버 재시작 시 조용히 사라짐). 이제 저장 실패 시
  // 메모리도 수정 전 상태로 롤백하고, 클라이언트에는 실패를 알려서 사용자가 다시
  // 시도할 수 있게 한다(클라이언트는 이 에러를 받으면 알림창을 띄우고 화면은 그대로
  // 유지한다 — App.tsx의 handleUpdateCard 참고).
  const saved = await setScopedDoc(scopeId, 'contacts', updated);
  if (!saved) {
    dbData.contacts[idx] = previousContact;
    return res.status(500).json({ error: '명함 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(updated);
});

app.delete('/api/contacts/:id', async (req, res) => {
  // ✅ 데이터 수정 Rate Limiting
  if (!checkModifyRateLimit(req, res)) return;

  const dbData = getScopedData(req);
  dbData.contacts = dbData.contacts.filter(c => c.id !== req.params.id);
  await deleteScopedDoc(req.scopeId, 'contacts', req.params.id);
  res.json({ success: true });
});

// [추가] 명함 주소(address/address2/homeAddress)에 잘못 섞여 들어간 "\" 문자를 찾아서
// 지워주는 관리자 전용 정리 도구. 명함 스캔/OCR이나 붙여넣기 과정에서 주소 중간에
// 이스케이프 문자 같은 "\"가 실수로 섞여 들어간 경우를 위한 일회성 정리 기능이다.
// 실수로 잘못 지워지는 걸 막기 위해, 실제로 적용(clean)하기 전에 어떤 명함이 어떻게
// 바뀌는지 먼저 보여주는 스캔(scan) 엔드포인트를 따로 둔다 - 관리자만 쓸 수 있다.
function stripBackslashFromAddress(value: string): string {
  return value.replace(/\\/g, '').replace(/\s{2,}/g, ' ').trim();
}
function findBackslashAddressFixes(dbData: ScopedData) {
  const fields: Array<'address' | 'address2' | 'homeAddress'> = ['address', 'address2', 'homeAddress'];
  const results: { id: string; name: string; company: string; changes: Record<string, { before: string; after: string }> }[] = [];
  for (const c of (dbData.contacts || [])) {
    const changes: Record<string, { before: string; after: string }> = {};
    for (const field of fields) {
      const before = (c as unknown as Record<string, unknown>)[field];
      if (typeof before === 'string' && before.includes('\\')) {
        changes[field] = { before, after: stripBackslashFromAddress(before) };
      }
    }
    if (Object.keys(changes).length > 0) {
      results.push({ id: c.id, name: c.name, company: c.company, changes });
    }
  }
  return results;
}

app.get('/api/admin/contacts-backslash-scan', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);
  res.json(findBackslashAddressFixes(dbData));
});

app.post('/api/admin/contacts-backslash-clean', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const fixes = findBackslashAddressFixes(dbData);
  if (!fixes.length) return res.json({ fixedCount: 0 });

  const fixIds = new Set(fixes.map(f => f.id));
  const updatedContacts: BusinessCard[] = [];
  dbData.contacts = dbData.contacts.map((c: BusinessCard) => {
    if (!fixIds.has(c.id)) return c;
    const fix = fixes.find(f => f.id === c.id)!;
    const changedFields = Object.fromEntries(Object.keys(fix.changes).map((f) => [f, fix.changes[f].after]));
    const updated: BusinessCard = { ...c, ...changedFields };
    updatedContacts.push(updated);
    return updated;
  });
  await setScopedDocs(scopeId, 'contacts', updatedContacts);
  res.json({ fixedCount: updatedContacts.length });
});

// 그룹 CRUD
app.get('/api/groups', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);

  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const dbData = getScopedData(req);
  const groups = dbData.groups || [];
  // [수정] "나만 보기(비공개)"로 설정된 그룹은 만든 본인에게만 보이고, 다른 사람에게는
  // 목록/필터 칩 자체에서 숨긴다. 명함의 isPrivate와 동일한 방식.
  const visible = groups.filter(g => !g.isPrivate || !g.createdByUserId || g.createdByUserId === requesterId);
  res.json(visible);
});

app.post('/api/groups', async (req, res) => {
  const dbData = getScopedData(req);
  const g: ContactGroup = req.body;
  if (!g.id) g.id = `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!g.color) g.color = 'bg-slate-700 text-white border-slate-600';
  const requesterId = req.headers['x-user-id'] as string;
  const requester = requesterId ? users.find(u => u.id === requesterId) : undefined;
  if (requester) {
    g.createdByUserId = requester.id;
    g.createdByUserName = requester.name;
  }
  dbData.groups.push(g);
  await setScopedDoc(req.scopeId, 'groups', g);
  res.status(201).json(g);
});

app.put('/api/groups/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const idx = dbData.groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Group not found' });
  dbData.groups[idx] = { ...dbData.groups[idx], ...req.body };
  await setScopedDoc(req.scopeId, 'groups', dbData.groups[idx]);
  res.json(dbData.groups[idx]);
});

app.delete('/api/groups/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const gid = req.params.id;
  dbData.groups = dbData.groups.filter(g => g.id !== gid);
  // 삭제된 그룹에 속해있던 연락처는 첫 번째 그룹으로 이동
  const defaultGid = dbData.groups[0]?.id || '';
  const movedContacts: BusinessCard[] = [];
  dbData.contacts = dbData.contacts.map(c => {
    if (c.groupId !== gid) return c;
    const moved = { ...c, groupId: defaultGid };
    movedContacts.push(moved);
    return moved;
  });
  await deleteScopedDoc(scopeId, 'groups', gid);
  if (movedContacts.length) await setScopedDocs(scopeId, 'contacts', movedContacts);
  res.json({ success: true });
});

// 통화 히스토리 추가
app.post('/api/contacts/:id/history', async (req, res) => {
  const dbData = getScopedData(req);
  const idx = dbData.contacts.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Contact not found' });
  
  const record: CallRecord = {
    id: `call-${Date.now()}`,
    contactId: req.params.id,
    type: req.body.type || 'incoming',
    timestamp: req.body.timestamp || new Date().toISOString(),
    duration: req.body.duration || undefined,
    note: req.body.note || undefined
  };
  
  dbData.contacts[idx].callHistory.unshift(record);
  await setScopedDoc(req.scopeId, 'contacts', dbData.contacts[idx]);
  res.json(dbData.contacts[idx]);
});

// [추가] 명함 테두리 조정 화면을 열자마자 AI로 카드 실물의 네 모서리를 먼저 찾아주는 API.
// 기존 화면(브라우저)에서만 돌아가는 OpenCV 자동감지는 배경이 어둡거나 카드와 색·질감이
// 비슷하면(회색 옷감, 아스팔트 바닥 등) 테두리를 잘 못 찾는 문제가 있었다. Gemini는 "명함처럼
// 생긴 사각형 패턴" 자체를 인식하기 때문에 훨씬 안정적이다. 전체 OCR(scan-card)과 달리
// 텍스트 필드 없이 좌표만 요청해서 더 가볍고 빠르게 응답받는다.
app.post('/api/detect-card-corners', async (req, res) => {
  try {
    const scanUserId = (req.headers['x-user-id'] as string) || req.ip || 'unknown';
    const scanLimit = aiScanRateLimiter.check(scanUserId);
    if (!scanLimit.allowed) {
      return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
    }
    aiScanRateLimiter.registerAttempt(scanUserId);

    const { image } = req.body;
    if (!image) return res.status(400).json({ error: '이미지가 전송되지 않았습니다.' });
    if (typeof image !== 'string' || !image.startsWith('data:image')) {
      // [추가] scan-card와 동일한 이유로, base64 사진 데이터가 아니면 조용히 감지 실패로
      // 처리한다(이 API는 실패해도 화면에서 OpenCV 결과를 그대로 쓰면 되므로 500 대신 null).
      return res.json({ corners: null });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ corners: null });

    const ai = new GoogleGenAI({ apiKey });
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');

    const contents: Array<string | { inlineData: { mimeType: string; data: string } }> = [
      "이 사진에 찍힌 명함(종이 카드) 실물의 네 모서리 좌표를 찾아줘. " +
      "좌표는 이미지의 가로/세로 크기에 대한 0~1 사이의 비율로 표현해줘 (예: 이미지 맨 왼쪽 위는 x:0, y:0). " +
      "카메라 각도 때문에 명함이 기울어져 찍혔어도 실제 카드의 네 꼭짓점 위치를 최대한 정확하게 찾아줘 " +
      "(카드 주변 배경, 바닥, 옷, 손가락, 그림자는 절대 포함하지 말고 카드 실물 가장자리에 딱 맞춰줘). " +
      "사진에 명함이 안 보이면 corners를 null로 리턴해줘.\n" +
      "응답은 반드시 아래 JSON 규격에 맞게 순수 JSON 데이터만 리턴해줘. 마크다운 백틱 없이.\n" +
      "{\n" +
      '  "corners": {"topLeft": {"x":0,"y":0}, "topRight": {"x":0,"y":0}, "bottomRight": {"x":0,"y":0}, "bottomLeft": {"x":0,"y":0}}\n' +
      "}",
      { inlineData: { mimeType: 'image/jpeg', data: base64Data } }
    ];

    const response = await generateContentWithRetry(ai, {
      model: PRIMARY_GEMINI_MODEL,
      contents: contents
    });

    const text = response.text || '';
    let parsedJson: Record<string, unknown> = { corners: null };
    try {
      const jsonStr = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      parsedJson = JSON.parse(jsonStr);
    } catch (e) {
      console.error('테두리 감지 JSON 파싱 실패:', text);
    }

    res.json(parsedJson);
  } catch (error: unknown) {
    console.error('AI 테두리 감지 오류:', error);
    // [수정] 이 API가 실패해도 화면에서는 기존 OpenCV 감지 결과를 그대로 쓰면 되므로,
    // 500 에러 대신 corners: null로 조용히 응답해서 화면 쪽 에러 처리를 단순하게 한다.
    res.json({ corners: null });
  }
});

// Gemini Vision 명함 OCR API
app.post('/api/scan-card', async (req, res) => {
  try {
    const scanUserId = (req.headers['x-user-id'] as string) || req.ip || 'unknown';
    const scanLimit = aiScanRateLimiter.check(scanUserId);
    if (!scanLimit.allowed) {
      return res.status(429).json({ error: '명함 스캔 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
    }
    aiScanRateLimiter.registerAttempt(scanUserId);

    const { frontImage, backImage } = req.body;
    if (!frontImage && !backImage) {
      return res.status(400).json({ error: '명함 이미지가 전송되지 않았습니다.' });
    }
    // [추가] 클라이언트가 실수로 base64 사진 데이터가 아니라 저장소 URL 문자열을 그대로
    // 보내는 경우(예: 아직 base64로 안 바꾼 기존 이미지 주소), Gemini에 그대로 넘기면
    // "Base64 decoding failed for https://..." 같은 알아보기 힘든 에러가 났었다. 여기서
    // 미리 걸러서 원인을 바로 알 수 있는 메시지로 답한다.
    const isDataUrl = (v) => typeof v === 'string' && v.startsWith('data:image');
    if ((frontImage && !isDataUrl(frontImage)) || (backImage && !isDataUrl(backImage))) {
      return res.status(400).json({ error: '이미지 데이터 형식이 올바르지 않습니다 (base64 사진 데이터가 아닌 URL 등이 전달됨).' });
    }

    // [추가] 명함 이미지 크기 제한 (5MB)
    if (frontImage) {
      const frontValidation = validateImageSize(frontImage, 5);
      if (!frontValidation.valid) {
        return res.status(400).json({ error: `앞면 ${frontValidation.error}` });
      }
    }
    if (backImage) {
      const backValidation = validateImageSize(backImage, 5);
      if (!backValidation.valid) {
        return res.status(400).json({ error: `뒷면 ${backValidation.error}` });
      }
    }

    // [추가] 명함 인식 1순위: Gemini 멀티모달로 항목별 구조화 추출 (영수증과 같은 방식).
    // 이름/회사/직함을 "줄 순서"로 추측하던 기존 방식보다 정확하고, 부서·주소·팩스 등도 채운다.
    // 실패하거나 GEMINI_API_KEY가 없으면 아래 Vision OCR + 정규식 방식으로 넘어간다.
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const cardPrompt =
          "이 이미지는 명함이다 (앞면, 뒷면이 함께 올 수 있다). 명함에 적힌 정보를 항목별로 추출해줘.\n" +
          "- 이름, 회사명, 부서, 직함(직위)은 명함에 적힌 그대로 써라. 로고나 장식 문구를 이름으로 잡지 마라.\n" +
          "- 휴대폰(010)과 사무실 번호를 구분해라. 팩스는 phoneFax에 넣어라. 없으면 빈 문자열.\n" +
          "- 이메일, 홈페이지(website), 주소(address는 대표 주소, address2는 두 번째 주소)를 찾아라.\n" +
          "- 뒷면에만 있는 정보도 포함해라.\n" +
          "- 명함에 없는 정보는 지어내지 말고 빈 문자열로 둬라.\n" +
          "응답은 순수 JSON만 리턴해라 (마크다운 백틱 금지):\n" +
          "{\n" +
          '  "name": "", "company": "", "department": "", "title": "",\n' +
          '  "phoneMobile": "", "phoneOffice": "", "phoneOffice2": "", "phoneFax": "",\n' +
          '  "email": "", "website": "", "address": "", "address2": "", "memo": ""\n' +
          "}";
        const parts: Array<string | { inlineData: { mimeType: string; data: string } }> = [cardPrompt];
        for (const img of [frontImage, backImage]) {
          if (!img) continue;
          parts.push({
            inlineData: { mimeType: imageMimeOf(String(img)), data: String(img).replace(/^data:image\/\w+;base64,/, '') }
          });
        }
        const geminiRes = await generateContentWithRetry(ai, {
          model: PRIMARY_GEMINI_MODEL,
          contents: parts,
          config: JSON_CONFIG
        });
        const raw = (geminiRes.text || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const pick = (k: string): string => (typeof parsed[k] === 'string' ? (parsed[k] as string).trim() : '');
        return res.json({
          name: pick('name'),
          company: pick('company'),
          department: pick('department'),
          title: pick('title'),
          phoneMobile: pick('phoneMobile'),
          phoneOffice: pick('phoneOffice'),
          phoneOffice2: pick('phoneOffice2'),
          phoneFax: pick('phoneFax'),
          email: pick('email'),
          website: pick('website'),
          address: pick('address'),
          address2: pick('address2'),
          memo: pick('memo'),
          companyInfo: ''
        });
      } catch (geminiErr: unknown) {
        console.error('Gemini 명함 인식 실패, Vision OCR로 대체:', geminiErr);
      }
    }

    const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
    if (!apiKey) {
      // [수정] 운영(production)에서는 가짜 명함("홍길동")을 저장하지 않도록 오류로 알린다.
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: '명함 인식 설정(API 키)이 없습니다. 관리자에게 문의해 주세요.' });
      }
      // API Key가 미설정인 경우 프리뷰/테스트를 위해 모의 데이터 제공 (개발 환경 전용)
      return res.json({
        name: '홍길동',
        company: '(주)스마트테크',
        department: '디지털 전환팀',
        title: '부장',
        phoneMobile: '010-1234-5678',
        phoneOffice: '02-123-4567',
        phoneOffice2: '070-7654-3210',
        phoneFax: '02-123-4568',
        email: 'gildong.hong@smarttech.co.kr',
        address: '서울특별시 강남구 테헤란로 123',
        address2: '경기도 성남시 분당구 판교역로 231',
        memo: '샘플 데이터 (GOOGLE_CLOUD_VISION_API_KEY 설정 시 실시간 OCR 가동)',
        companyInfo: ''
      });
    }
    
    // Google Cloud Vision API REST 호출
    const requests: unknown[] = [];

    if (frontImage) {
      const base64Data = frontImage.replace(/^data:image\/\w+;base64,/, '');
      requests.push({
        image: { content: base64Data },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
      });
    }

    if (backImage) {
      const base64DataBack = backImage.replace(/^data:image\/\w+;base64,/, '');
      requests.push({
        image: { content: base64DataBack },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
      });
    }

    try {
      const visionResponse = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
      });

      if (!visionResponse.ok) {
        const errorData = await visionResponse.json();
        throw new Error(`Vision API Error: ${errorData.error?.message || 'Unknown error'}`);
      }

      const visionResult = await visionResponse.json();

      // 텍스트 추출
      let fullText = '';
      if (visionResult.responses && visionResult.responses.length > 0) {
        for (const response of visionResult.responses) {
          if (response.fullTextAnnotation) {
            fullText += response.fullTextAnnotation.text + '\n';
          }
        }
      }

      // 정규식으로 정보 추출
      const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
      const phoneRegex = /(\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{4}|\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4})/g;
      const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9.-]+\.[a-z]{2,}(?![a-z]))/gi;

      const phones = fullText.match(phoneRegex) || [];
      const emails = fullText.match(emailRegex) || [];
      const urls = fullText.match(urlRegex) || [];

      // 첫 번째 줄들에서 이름과 회사 추론
      const lines = fullText.split('\n').filter(l => l.trim()).slice(0, 5);

      const parsedJson: Record<string, unknown> = {
        name: lines[0] || '',
        company: lines[1] || '',
        department: '',
        title: lines[2] || '',
        phoneMobile: phones.find(p => p.startsWith('010')) || phones[0] || '',
        phoneOffice: phones[1] || '',
        phoneOffice2: phones[2] || '',
        phoneFax: '',
        email: emails[0] || '',
        address: '',
        address2: '',
        website: urls.find(u => u.includes('.')) || '',
        memo: fullText.split('\n').slice(0, 3).join(' ').substring(0, 100),
        companyInfo: ''
      };

      res.json(parsedJson);
    } catch (visionError: unknown) {
      console.error('Vision API Error:', visionError);
      throw visionError;
    }
  } catch (error: unknown) {
    console.error('Gemini OCR Error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

// ------------------------------------------------------------------
// 🎙️ AI 회의록 자동화 — 미팅 중 음성 인식으로 받아적은 두서없는 텍스트를,
// AI가 깔끔한 회의록 형태로 정리해주고, 액션 아이템과 언급된 금액(지출 후보)까지 뽑아준다.
// ------------------------------------------------------------------
app.post('/api/summarize-meeting', async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText || !String(rawText).trim()) {
      return res.status(400).json({ error: '정리할 회의 내용이 없습니다.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });
    const ai = new GoogleGenAI({ apiKey });

    const prompt =
      "다음은 미팅/거래처 방문 중에 음성 인식으로 받아적어서, 문장이 두서없고 정리가 안 되어 있는 회의 메모야. " +
      "이걸 실제 업무 팔로우업 기록으로 쓸 수 있게 정리해줘.\n\n" +
      `[원본 메모]\n${rawText}\n\n` +
      "다음 JSON 규격에 맞게 순수 JSON만 리턴해줘. 마크다운 백틱 없이. " +
      "원본에 없는 내용을 지어내지 말고, 실제 언급된 내용만 정리해줘.\n" +
      "{\n" +
      '  "summary": "핵심 내용을 자연스러운 문장 2~4개로 정리한 회의록 (두서없던 말투를 업무 기록체로 다듬어줘)",\n' +
      '  "actionItems": ["다음에 하기로 한 일 1", "다음에 하기로 한 일 2"], // 언급이 없으면 빈 배열\n' +
      '  "mentionedAmounts": [{"amount": 500000, "context": "식대로 언급된 금액"}], // 원 단위 숫자로 변환, 언급 없으면 빈 배열\n' +
      "}";

    const response = await generateContentWithRetry(ai, {
      model: PRIMARY_GEMINI_MODEL,
      contents: prompt
    });

    const text = response.text || '';
    let parsed: Record<string, unknown> = {};
    try {
      const cleaned = text.replace(/```json\s*|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { summary: text.trim(), actionItems: [], mentionedAmounts: [] };
    }

    res.json({
      summary: parsed.summary || '',
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      mentionedAmounts: Array.isArray(parsed.mentionedAmounts) ? parsed.mentionedAmounts : []
    });
  } catch (error: unknown) {
    console.error('회의록 AI 요약 오류:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

// ------------------------------------------------------------------
// 🎤 음성 명함 등록 — 전시회처럼 손이 바쁠 때 "방금 만난 사람 이름 불러줘"로
// 빠르게 기록할 수 있도록, 말한 문장에서 이름/회사/직책을 AI가 뽑아준다.
// 사진 없이 일단 저장해두고, 나중에 실제 명함을 스캔하면 기존 중복 감지 로직이
// 자동으로 "기존 정보 업데이트"를 제안해서 완성되는 구조다.
// ------------------------------------------------------------------
app.post('/api/parse-voice-contact', async (req, res) => {
  try {
    const { rawText } = req.body;
    if (!rawText || !String(rawText).trim()) {
      return res.status(400).json({ error: '인식된 음성 내용이 없습니다.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });
    const ai = new GoogleGenAI({ apiKey });

    const prompt =
      "다음은 전시회나 미팅 자리에서 방금 만난 사람에 대해 손이 바빠서 음성으로 급하게 말한 내용이야. " +
      "이름과 (언급됐다면) 회사명/직책/부서/메모를 뽑아줘.\n\n" +
      `[음성 인식 텍스트]\n${rawText}\n\n` +
      "다음 JSON 규격에 맞게 순수 JSON만 리턴해줘. 마크다운 백틱 없이. " +
      "언급 안 된 항목은 빈 문자열로 둬. 이름은 최대한 추정해서라도 채워줘(사람 이름으로 들리는 단어).\n" +
      "{\n" +
      '  "name": "성명",\n' +
      '  "company": "회사명",\n' +
      '  "department": "부서명",\n' +
      '  "title": "직책/직급",\n' +
      '  "memo": "그 외 언급된 내용(예: 어디서 만났는지, 관심사 등)"\n' +
      "}";

    const response = await generateContentWithRetry(ai, {
      model: PRIMARY_GEMINI_MODEL,
      contents: prompt
    });

    const text = response.text || '';
    let parsed: Record<string, unknown> = {};
    try {
      const cleaned = text.replace(/```json\s*|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { name: rawText.trim().split(/[\s,]+/)[0] || '', company: '', department: '', title: '', memo: rawText };
    }

    res.json({
      name: parsed.name || '',
      company: parsed.company || '',
      department: parsed.department || '',
      title: parsed.title || '',
      memo: parsed.memo || ''
    });
  } catch (error: unknown) {
    console.error('음성 명함 파싱 오류:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

// Gemini Vision 영수증 OCR API
app.post('/api/scan-receipt', async (req, res) => {
  try {
    const scanUserId = (req.headers['x-user-id'] as string) || req.ip || 'unknown';
    const scanLimit = aiScanRateLimiter.check(scanUserId);
    if (!scanLimit.allowed) {
      return res.status(429).json({ error: '영수증 스캔 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
    }
    aiScanRateLimiter.registerAttempt(scanUserId);

    const { image, context } = req.body;
    if (!image) {
      return res.status(400).json({ error: '영수증 이미지가 전송되지 않았습니다.' });
    }

    // [추가] 영수증 이미지 크기 제한 (5MB)
    const imageValidation = validateImageSize(image, 5);
    if (!imageValidation.valid) {
      return res.status(400).json({ error: imageValidation.error });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // [수정] 키가 없으면 문자 인식(OCR)으로 최소한의 값을 채운다. 샘플 금액은 개발 환경에서만 쓴다.
      const ocrOnly = extractReceiptFromOcrText(await visionOcrText(image), context);
      if (ocrOnly) return res.json(ocrOnly);
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: '영수증 인식 설정(API 키)이 없습니다. 관리자에게 문의해 주세요.' });
      }
      // API Key가 미설정인 경우 프리뷰/테스트를 위한 모의 파싱 결과 제공 (개발 환경 전용)
      // (해외 출장 경비 화면은 카테고리/결제수단 값 체계가 달라서 샘플 데이터도 그에 맞게 분기)
      return res.json(
        context === 'overseas_trip'
          ? {
              amount: 35000,
              date: new Date().toISOString().split('T')[0],
              merchantName: '성북구 낙산 갈비마을',
              memo: '출장 중 식사 (영수증 자동 스캔 완료 - 샘플 데이터)',
              category: '식비',
              payMethod: '신용카드'
            }
          : {
              amount: 35000,
              date: new Date().toISOString().split('T')[0],
              merchantName: '성북구 낙산 갈비마을',
              memo: '식대 결제 건 (영수증 자동 스캔 완료 - 샘플 데이터)',
              category: 'meal',
              payMethod: 'company_card'
            }
      );
    }

    const ai = new GoogleGenAI({ apiKey });
    
    // 이미지 파트 생성
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const contents: Array<string | { inlineData: { mimeType: string; data: string } }> = [
      "이 영수증 이미지(또는 비용 영수증 사진)를 분석하여 지출 정보를 추출하고 적합한 카테고리를 분류해줘.\n" +
      // [추가] 해외 출장 경비(회계관리 > AdminDocsView, context === 'overseas_trip') 화면에서
      // 올라온 영수증은 국내 일반 비용(주유비/식대 등)과 분류 체계가 전혀 달라서(항공료/숙박비/
      // 환전 비용 등), 기존 카테고리 목록을 그대로 쓰면 항공권·호텔 영수증이 전부 'other'로만
      // 잡힌다. 이 화면 전용으로, 그 화면이 실제로 쓰는 한글 사용구분 값을 그대로 분류하게 해서
      // 클라이언트에서 별도 코드↔한글 매핑 없이 바로 써도 서로 어긋나지 않게 한다.
      (context === 'overseas_trip'
        ? "분류할 카테고리(사용구분)는 다음 중에서 가장 알맞은 하나를 한글 그대로 선택해줘:\n" +
          "- '항공료' (항공권, 수하물 요금 등 항공 관련 비용)\n" +
          "- '숙박비' (호텔, 숙소 비용)\n" +
          "- '식비' (식사, 카페, 음료 등)\n" +
          "- '교통비' (택시, 대중교통, 렌터카, 주차, 통행료, 공항 이동 등)\n" +
          "- '환전 비용' (환전 수수료, 환전소 결제 등)\n" +
          "- '직원 선물' (출장 중 구입한 선물/기념품)\n" +
          "- '기타' (위 분류에 안 맞는 기타 출장 지출)\n\n"
        : "분류할 카테고리는 다음 중에서 가장 알맞은 하나를 선택해줘:\n" +
          "- 'fuel' (주유비, 충전비)\n" +
          "- 'parking' (주차비)\n" +
          "- 'toll' (통행료, 고속도로 통행료)\n" +
          "- 'meal' (식대, 식사비, 한식, 양식, 중식, 일식 등)\n" +
          "- 'beverage' (음료, 커피, 디저트, 카페 건)\n" +
          "- 'supplies' (비품 구입, 사무용품, 문구, 물품 구매)\n" +
          "- 'maintenance' (차량 정비, 수리, 엔진오일 교환 등)\n" +
          "- 'agency_drive' (대리운전)\n" +
          "- 'other' (기타 지출)\n\n") +
      (context === 'overseas_trip'
        ? "결제수단은 다음 중 가장 알맞은 하나를 한글 그대로 선택해줘:\n" +
          "- '신용카드' (신용카드/체크카드 결제, 법인카드 포함)\n" +
          "- '현금' (현금 결제, 현지 통화 결제, 현금 영수증 포함)\n\n"
        : "결제수단은 다음 중 가장 알맞은 하나를 선택해줘:\n" +
          "- 'company_card' (법인카드, 신용카드 영수증에 법인카드 표시가 있거나 회사 비용인 경우)\n" +
          "- 'personal_card' (개인카드)\n" +
          "- 'cash' (현금 영수증, 간이 영수증, 현금 결제)\n\n") +
      // [추가] "법인카드 등록 정보와 대조해서 맞으면 법인카드로 우선 판단" 요청에 맞춰,
      // 영수증에 인쇄된 카드번호(마스킹되어 일부만 보여도 그 보이는 부분)를 같이 추출해달라고
      // 요청한다. 아래에서 이 값을 경영지원 > 법인카드 관리에 등록된 카드번호들과 대조해서,
      // 일치하면 AI가 뭐라고 판단했든 payMethod를 company_card로 강제로 바꿔준다 - 영수증에
      // "법인카드"라는 문구가 안 찍혀 있어서 AI가 애매하게 개인카드/현금으로 잘못 고르는
      // 경우를 실제 등록된 카드 정보로 보정하기 위함이다.
      // [수정] 처음엔 "보이는 숫자를 순서대로 이어붙여서" 한 필드로만 받았는데, 실제
      // 영수증은 "앞자리 일부 + 중간 마스킹 + 뒷자리 일부"가 같이 찍히는 경우가 흔하다
      // (예: "5229715 1**686*"). 이걸 그냥 이어붙이면("52297151686") 등록 카드번호의
      // 앞부분도 뒷부분도 아닌 애매한 문자열이 돼서 대조에 실패한다. 그래서 앞쪽에 연속으로
      // 보이는 숫자와 뒤쪽에 연속으로 보이는 숫자를 별도 필드로 나눠 받아, 아래에서 각각
      // 등록 카드번호의 앞부분/끝부분과 정확히 대조한다.
      "추가로, 영수증에 카드번호가 인쇄되어 있으면(마스킹되어 일부만 보여도 상관없음) 다음 두 " +
      "부분을 각각 알려줘 (별표(*)나 마스킹 기호, 하이픈, 공백은 빼고 숫자만):\n" +
      "1) 카드번호 맨 앞쪽에서부터 마스킹되기 전까지 연속으로 보이는 숫자\n" +
      "2) 카드번호 맨 뒤쪽에서 마스킹이 끝난 다음부터 끝까지 연속으로 보이는 숫자\n" +
      "(앞쪽 또는 뒤쪽이 아예 안 보이면 그 항목은 빈 문자열로 주고, 카드번호 자체가 전혀 " +
      "안 보이면 둘 다 빈 문자열로 줘.)\n\n" +
      // [추가] 정비내역 등록 화면(context === 'maint')에서 올라온 영수증만 아래 안내를
      // 추가로 붙여준다. 정비소가 발급하는 문서는 일반 카드 매출전표(카페, 주유소 등)와
      // 달리 세금계산서·정비 명세서·견적서 형태인 경우가 많아, 상호명이 눈에 잘 띄지 않는
      // 위치에 있거나 부품비/공임비/부가세가 여러 줄로 나뉘어 있어 AI가 최종 합계가 아닌
      // 중간 금액 한 줄만 집어내는 경우가 있었다. 다른 화면(운행기록/일반비용)의 프롬프트는
      // 그대로 두고 이 화면일 때만 안내를 덧붙여서 영향 범위를 최소화한다.
      (context === 'maint'
        ? "이 사진은 자동차 정비소/카센터에서 발급한 영수증, 세금계산서, 정비 명세서, 견적서 중 " +
          "하나일 수 있다. 일반 카드 매출전표뿐 아니라 이런 문서 형태에도 익숙하다고 가정하고 아래를 지켜줘.\n" +
          "- 상호명(merchantName)은 문서 상단이나 하단 어디에 있든 정비업체의 사업자명/상호를 찾아서 반환해라.\n" +
          "- 부품비, 공임비, 소계, 부가가치세(VAT) 등 금액이 여러 줄로 나뉘어 있으면 절대 그 중 한 줄만 " +
          "집지 말고, 반드시 최종 '합계금액' 또는 '청구금액'(부가세 포함 총액)을 amount로 반환해라.\n\n"
        : "") +
      // [수정] 지출 정보뿐 아니라, 사진 속에서 "영수증 실물의 네 꼭짓점이 어디인지"도 같이 알려달라고
      // 요청한다. 화면의 명암 차이만으로 테두리를 찾는 기존 방식은 영수증처럼 휘거나 구겨진 얇은
      // 종이, 또는 배경과 색이 비슷한 경우 실패하기 쉬운데, AI는 "영수증처럼 생긴 패턴" 자체로
      // 인식하기 때문에 훨씬 안정적이다.
      "추가로, 사진에 찍힌 영수증 실물(종이 자체)의 네 모서리 좌표를 알려줘. " +
      "좌표는 이미지의 가로/세로 크기에 대한 0~1 사이의 비율로 표현해줘 (예: 이미지 맨 왼쪽 위 모서리는 x:0, y:0). " +
      "영수증이 살짝 휘거나 구겨져 있어도, 실제 종이의 네 꼭짓점 위치를 최대한 정확하게 찾아줘 " +
      "(주변 배경, 손가락, 그림자는 절대 포함하지 말고 영수증 실물 가장자리에 딱 맞춰줘).\n" +
      "응답은 반드시 아래 JSON 규격에 맞게 순수 JSON 데이터만 리턴해줘. 마크다운 백틱(```json) 없이 리턴하거나 있어도 JSON 파싱 가능해야 함.\n" +
      "{\n" +
      '  "amount": 12000, // 숫자형 지출 금액 (원화 단위를 파싱하여 숫자만 기재, 콤마 제외)\n' +
      '  "date": "2026-03-12", // 지출 일자 (YYYY-MM-DD 포맷, 연도가 없으면 가장 최근 연도나 올해 연도로 가정)\n' +
      '  "merchantName": "상호명 또는 가맹점명 (예: 스타벅스 강남점)",\n' +
      '  "memo": "구매 품목 요약 또는 메모 (예: 아메리카노 외 2건)",\n' +
      '  "category": "선택한 카테고리 코드 (예: beverage)",\n' +
      '  "payMethod": "선택한 결제수단 코드 (예: company_card)",\n' +
      '  "cardNumberFrontVisible": "카드번호 앞쪽에서 마스킹 전까지 보이는 숫자 (하이픈/공백 제외, 없으면 빈 문자열)",\n' +
      '  "cardNumberLastVisible": "카드번호 뒤쪽에서 마스킹 이후 보이는 숫자 (하이픈/공백 제외, 없으면 빈 문자열)",\n' +
      '  "corners": {"topLeft": {"x":0,"y":0}, "topRight": {"x":0,"y":0}, "bottomRight": {"x":0,"y":0}, "bottomLeft": {"x":0,"y":0}}\n' +
      "}"
    ];

    contents.push({
      inlineData: {
        mimeType: imageMimeOf(image),
        data: base64Data
      }
    });

    let parsedJson: Record<string, unknown> | null = null;
    try {
      const response = await generateContentWithRetry(ai, {
        model: PRIMARY_GEMINI_MODEL,
        contents: contents,
        config: JSON_CONFIG
      });
      parsedJson = parseJsonLoose(response.text || '');
      if (!parsedJson) console.error('영수증 JSON 파싱 실패:', (response.text || '').slice(0, 300));
    } catch (geminiErr: unknown) {
      console.error('Gemini 영수증 인식 실패, 문자 인식(OCR)으로 대체:', geminiErr);
    }
    if (!parsedJson) {
      // [추가] Gemini가 실패하거나 응답을 읽지 못하면 Vision 문자 인식으로 대체한다.
      parsedJson = extractReceiptFromOcrText(await visionOcrText(image), context);
    }
    if (!parsedJson) {
      return res.status(502).json({ error: '영수증 인식 결과를 읽지 못했습니다. 영수증 전체가 밝게 보이도록 다시 촬영해 주세요.' });
    }

    // [수정] "영수증 스캔 시 법인카드 등록 정보(카드번호)와 대조해서 맞으면 법인카드로
    // 우선 판단" - AI가 영수증에서 읽어낸 카드번호 앞쪽/뒤쪽 노출 숫자를, 경영지원 >
    // 법인카드 관리(admin-docs의 corp_card 카테고리)에 등록된 카드번호들과 각각 대조한다.
    // 예전에는 "보이는 숫자를 이어붙인 한 문자열"만으로 대조해서, "앞자리 일부 + 뒷자리
    // 일부"가 같이 찍히는 흔한 마스킹(예: "5229715 1**686*")에서는 이어붙인 값이 등록
    // 카드번호의 앞부분도 뒷부분도 아니게 돼 매칭이 실패했다. 이제는 앞/뒤를 따로 받아서
    // "앞쪽 노출 숫자로 시작하는지" / "뒤쪽 노출 숫자로 끝나는지"를 각각 확인하고, 둘 다
    // 읽혔으면 둘 다(앞뒤 모두) 일치할 때만, 하나만 읽혔으면(카드번호가 짧게 일부만
    // 보이는 경우) 그 하나가 일치하고 자릿수가 충분할 때만(오탐 방지) 같은 카드로 본다.
    // 등록된 카드가 없거나 카드번호를 전혀 못 읽었으면 원래 AI 판단(payMethod)을 그대로 둔다.
    try {
      const frontDigits = String(parsedJson.cardNumberFrontVisible || '').replace(/\D/g, '');
      const lastDigits = String(parsedJson.cardNumberLastVisible || '').replace(/\D/g, '');
      if (frontDigits.length >= 3 || lastDigits.length >= 3) {
        const dbData = getScopedData(req);
        const registeredCardDigits: string[] = [];
        for (const doc of (dbData.adminDocs || [])) {
          if (doc.category !== 'corp_card' || !doc.corpCard) continue;
          for (const c of (doc.corpCard.cards || [])) {
            const digits = String(c.cardNumber || '').replace(/\D/g, '');
            if (digits) registeredCardDigits.push(digits);
          }
        }
        const matchesRegisteredCard = registeredCardDigits.some((full) => {
          const frontOk = frontDigits.length >= 3 && full.length >= frontDigits.length && full.startsWith(frontDigits);
          const lastOk = lastDigits.length >= 3 && full.length >= lastDigits.length && full.endsWith(lastDigits);
          if (frontDigits.length >= 3 && lastDigits.length >= 3) return frontOk && lastOk; // 앞뒤 다 읽혔으면 둘 다 맞아야 함
          return frontOk || lastOk; // 한쪽만 읽혔으면 그 한쪽만 확인
        });
        if (matchesRegisteredCard) {
          // 해외 출장 경비는 결제수단 값 체계가 '신용카드'/'현금' 둘뿐이라 'company_card' 코드를
          // 그대로 쓰면 어느 프리셋에도 안 걸려 "직접 입력"으로 보이게 된다. 법인카드로 확인된
          // 경우도 이 화면에서는 '신용카드'로 맞춰준다.
          parsedJson.payMethod = context === 'overseas_trip' ? '신용카드' : 'company_card';
        }
      }
    } catch (matchErr) {
      console.error('법인카드 등록 정보 대조 실패(원래 AI 판단 그대로 사용):', matchErr);
    }

    res.json(parsedJson);
  } catch (error: unknown) {
    console.error('Receipt OCR Error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

// 회사 비즈니스 및 전년도 매출 규모 실시간 AI 검색 API
// [수정] 예전엔 "회사명은(는) ... 기업입니다" 식의 한 문장만 만들어서 저장했는데, 요청에
// 따라 업종/주요사업/매출/직원수/홈페이지/출처 URL을 각각 구조화된 값으로 따로 받아서
// company 테이블의 정해진 컬럼에 맞춰 저장한다. JSON 형태로 응답받아 파싱한다.
const COMPANY_SUMMARY_SCHEMA_VERSION = 1;

interface CompanySummaryFields {
  businessNumber: string | null;
  industry: string | null;
  mainBusiness: string | null;
  website: string | null;
  employees: string | null;
  sales: string | null;
  businessSummary: string | null;
}

async function generateCompanySummary(company: string): Promise<{ fields: CompanySummaryFields; sourceUrls: string[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // API Key가 없는 경우 테스트를 위해 그럴듯한 모의 데이터 생성해서 전달
    return {
      fields: {
        businessNumber: null,
        industry: '정보 확인 어려움',
        mainBusiness: '혁신 비즈니스를 영위하고 있는 기업입니다.',
        website: null,
        employees: '약 210명 수준 (모의 데이터)',
        sales: '약 1,250억원 (모의 데이터)',
        businessSummary: `${company}은(는) 혁신 비즈니스를 영위하고 있는 기업입니다. (전년도 매출액 규모: 약 1,250억원, 직원수: 약 210명 수준 / 실시간 AI 검색 결과를 보시려면 GEMINI_API_KEY를 등록하세요)`
      },
      sourceUrls: []
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `회사명 "${company}"에 대해 실시간 구글 검색(googleSearch)으로 다음 정보를 조사해줘:\n` +
    `- 사업자등록번호 (파악 가능한 경우만, 확인 어려우면 null)\n` +
    `- 업종\n` +
    `- 주요 사업 내용 (1줄 설명)\n` +
    `- 공식 홈페이지 주소 (파악 가능한 경우만, 없으면 null)\n` +
    `- 직원수 (가장 최근 파악 가능한 규모, 예: "약 150명", 확인 어려우면 "직원수 확인 어려움")\n` +
    `- 전년도 매출액 규모 (가장 최근 연 매출 규모, 예: "약 5,000억원", 확인 어려우면 "매출 정보 확인 어려움")\n` +
    `- 위 내용을 종합한 1~2줄 비즈니스 요약 문장 (예: "인공지능 기반 B2B DX 및 스마트 비즈니스 솔루션 기업 (전년도 매출액 약 320억원, 직원수 약 85명)")\n\n` +
    `응답은 반드시 아래 JSON 형식으로만, 마크다운 백틱이나 다른 설명 없이 순수 JSON만 반환해줘:\n` +
    `{"businessNumber": string|null, "industry": string|null, "mainBusiness": string|null, "website": string|null, "employees": string|null, "sales": string|null, "businessSummary": string}`;

  const response = await generateContentWithRetry(ai, {
    model: PRIMARY_GEMINI_MODEL,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }]
    }
  });

  let fields: CompanySummaryFields = {
    businessNumber: null, industry: null, mainBusiness: null, website: null, employees: null, sales: null,
    businessSummary: (response.text || '').trim()
  };
  try {
    const jsonStr = (response.text || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const parsed = JSON.parse(jsonStr);
    fields = {
      businessNumber: parsed.businessNumber || null,
      industry: parsed.industry || null,
      mainBusiness: parsed.mainBusiness || null,
      website: parsed.website || null,
      employees: parsed.employees || null,
      sales: parsed.sales || null,
      businessSummary: parsed.businessSummary || fields.businessSummary
    };
  } catch (e) {
    console.error('회사 요약 JSON 파싱 실패, 원문 텍스트를 요약으로만 사용:', response.text);
  }

  // googleSearch grounding이 근거로 삼은 출처 URL들을 뽑아둔다(있으면). SDK/모델 버전에 따라
  // 구조가 없을 수도 있어서 옵셔널 체이닝으로 방어적으로 읽는다.
  const sourceUrls: string[] = [];
  try {
    const chunks = (response as unknown as GeminiGroundingResponse)?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    for (const chunk of chunks) {
      const uri = chunk?.web?.uri;
      if (uri && !sourceUrls.includes(uri)) sourceUrls.push(uri);
    }
  } catch (e) {
    // 출처 URL은 있으면 좋고 없어도 치명적이지 않으므로 조용히 넘어간다.
  }

  return { fields, sourceUrls };
}

// [추가] 회사 요약을 "회사명" 기준으로 전체 서비스에서 공용으로 캐싱한다. 예전엔 명함마다
// (즉, 회사가 같아도 서로 다른 사용자/스코프에 등록돼 있으면) 매번 각자 따로 Gemini를
// 호출했다 — 같은 "삼성전자"를 여러 회사(스코프)의 사용자가 각자 검색하면 그만큼 낭비다.
// 이제는 Supabase의 전용 company 테이블(구조화된 컬럼: 업종/주요사업/매출/직원수/홈페이지/
// 출처 URL 등)에 저장해두고, 30일 안에 같은 회사를 다시 조회하면 그 표에서 바로 꺼내
// 쓴다(진짜로 Gemini를 새로 호출하는 횟수를 크게 줄이기 위함 - 하루 할당량이 20회뿐이라
// 특히 중요하다).
const COMPANY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

// "(주)", "주식회사", 공백, 대소문자 차이 때문에 같은 회사가 다른 키로 캐싱되는 것을
// 막기 위한 정규화. 완벽하진 않지만(예: 정식 법인명이 아예 다른 경우는 못 잡음) 실제
// 명함에 흔히 적히는 표기 차이는 대부분 커버한다.
function normalizeCompanyKey(company: string): string {
  return company
    .trim()
    .replace(/\(주\)|주식회사|㈜/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

async function getOrGenerateCompanySummary(company: string): Promise<{ summary: string; fromCache: boolean }> {
  const key = normalizeCompanyKey(company);

  // 캐시(company 테이블)는 Neon 마이그레이션 후 아직 구현되지 않아 여기서는 건너뛴다.

  const { fields, sourceUrls } = await generateCompanySummary(company);

  // [주의] Neon으로 마이그레이션하면서 company 테이블이 neonStore 스키마에 없음
  // TODO: company 테이블을 neonStore에 추가하거나, 다른 캐싱 메커니즘 구현 필요
  // if (key && process.env.DATABASE_URL && fields.businessSummary) {
  //   // company 테이블 캐싱 로직 (현재 비활성화)
  // }

  return { summary: fields.businessSummary || '', fromCache: false };
}


// [수정] 조회(캐시만 읽음, AI 호출 없음)와 갱신(실제 AI 검색)을 이름으로도 명확히 구분한다.
// - POST /api/company/intelligence      : 여러 회사를 한 번에 캐시에서만 조회 (읽기 전용)
// - POST /api/company/intelligence-refresh : 회사 하나를 실제로 AI 검색해서 캐시 갱신
// 예전 이름(search-summary, intelligence-batch)은 헷갈릴 수 있어서 그대로 별칭으로만
// 남겨두고, 새 코드는 아래 새 이름을 쓴다.
app.post('/api/company/intelligence-refresh', async (req, res) => {
  try {
    const { company } = req.body;
    if (!company) {
      return res.status(400).json({ error: '회사명이 필요합니다.' });
    }
    const { summary: companyInfo, fromCache } = await getOrGenerateCompanySummary(company);
    res.json({ companyInfo, fromCache });
  } catch (error: unknown) {
    console.error('Company intelligence refresh error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});
// 예전 이름 - 하위 호환용 별칭 (기존 배포 클라이언트가 캐시되어 있어도 계속 동작하도록)
app.post('/api/company/search-summary', async (req, res) => {
  try {
    const { company } = req.body;
    if (!company) {
      return res.status(400).json({ error: '회사명이 필요합니다.' });
    }
    const { summary: companyInfo, fromCache } = await getOrGenerateCompanySummary(company);
    res.json({ companyInfo, fromCache });
  } catch (error: unknown) {
    console.error('Company search summary error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

// [추가] AI Intelligence > 기업 인텔리전스 화면에서, 지금 스코프의 명함들이 속한 회사
// "여러 개"를 한 번에 훑어서 이미 캐시된 구조화 정보(업종/매출/직원수/홈페이지 등)가
// 있는 회사만 뽑아서 돌려준다. 캐시가 없는 회사는 그냥 목록에서 빠지고(=화면에서
// "아직 조회 안 됨"으로 표시), 이 API 자체는 Gemini를 호출하지 않는다(순수 조회 전용
// - 화면에서 개별로 "검색" 버튼을 눌러야 위의 intelligence-refresh가 실제로 호출된다).
app.post('/api/company/intelligence', async (req, res) => {
  try {
    const { companies } = req.body as { companies?: string[] };
    if (!Array.isArray(companies) || companies.length === 0) {
      return res.json({ items: [] });
    }
    // [주의] Neon으로 마이그레이션하면서 company 테이블이 neonStore 스키마에 없음
    // TODO: company 테이블을 neonStore에 추가하거나, 이 엔드포인트 제거 필요
    return res.json({ items: [] });
  } catch (error: unknown) {
    console.error('Company intelligence error:', error);
    res.status(500).json({ error: '기업 정보를 불러오지 못했습니다.' });
  }
});
// 예전 이름 - 하위 호환용 별칭
app.post('/api/company/intelligence-batch', async (req, res) => {
  try {
    const { companies } = req.body as { companies?: string[] };
    if (!Array.isArray(companies) || companies.length === 0) {
      return res.json({ items: [] });
    }
    if (!process.env.DATABASE_URL) return res.json({ items: [] });
    const keys = Array.from(new Set(companies.map((c) => normalizeCompanyKey(c)).filter(Boolean)));
    if (keys.length === 0) return res.json({ items: [] });
    // [주의] Neon으로 마이그레이션하면서 company 테이블이 neonStore 스키마에 없음
    // TODO: company 테이블 구현 또는 이 엔드포인트 제거 필요
    return res.json({ items: [] });
  } catch (error: unknown) {
    res.status(500).json({ error: '기업 정보를 불러오지 못했습니다.' });
  }
});

// [추가] 프로젝트 등록/수정 화면의 "시공사/건축설계사/인테리어설계사/전기설계사/
// 기계설계사/감리사/운영사" 칸을 직접 입력하는 대신, 프로젝트명(+최종고객/현장지역이
// 있으면 같이)을 바탕으로 구글 검색(googleSearch)으로 실제 참여사를 찾아서 자동으로
// 채워주는 기능. 위 회사 요약(generateCompanySummary)과 같은 Gemini+googleSearch
// 방식이지만, 회사 "하나"의 일반 정보가 아니라 특정 "프로젝트"에 관련된 여러 회사를
// 한 번에 찾는 것이라 별도 함수/캐시 없이(프로젝트마다 내용이 달라 회사명 캐시처럼
// 재사용할 수 없음) 매번 새로 검색한다. 확인이 어려운 항목은 추측하지 말고 반드시
// null로 두도록 프롬프트에서 명시한다 - 잘못된 회사명을 지어내는 것보다 빈 칸으로
// 남겨서 사용자가 직접 입력하게 하는 편이 안전하다.
interface ProjectRelationsFields {
  contractor: string | null;
  architect: string | null;
  interiorDesigner: string | null;
  electricalDesigner: string | null;
  mechanicalDesigner: string | null;
  supervisor: string | null;
  operator: string | null;
}

async function searchProjectRelations(input: { projectName: string; endCustomer?: string; siteLocation?: string }): Promise<{ fields: ProjectRelationsFields; sourceUrls: string[] }> {
  const emptyFields: ProjectRelationsFields = {
    contractor: null, architect: null, interiorDesigner: null, electricalDesigner: null,
    mechanicalDesigner: null, supervisor: null, operator: null
  };

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { fields: emptyFields, sourceUrls: [] };
  }

  const ai = new GoogleGenAI({ apiKey });
  const contextLines = [`프로젝트명(공사명/건물명 등): "${input.projectName}"`];
  if (input.endCustomer?.trim()) contextLines.push(`최종고객(발주처): "${input.endCustomer.trim()}"`);
  if (input.siteLocation?.trim()) contextLines.push(`현장/지역: "${input.siteLocation.trim()}"`);

  const prompt = `아래 건설/부동산/시설 프로젝트에 대해 실시간 구글 검색(googleSearch)으로 참여사를 조사해줘.\n\n` +
    `${contextLines.join('\n')}\n\n` +
    `찾아야 할 항목:\n` +
    `- contractor: 시공사\n- architect: 건축설계사\n- interiorDesigner: 인테리어설계사\n` +
    `- electricalDesigner: 전기설계사\n- mechanicalDesigner: 기계설계사\n- supervisor: 감리사\n- operator: 운영사\n\n` +
    `중요: 뉴스, 공식 발표, 입찰/수주 공고 등 신뢰할 수 있는 출처로 실제 확인되는 경우만 회사명을 채우고, ` +
    `검색으로 확인이 어렵거나 추측이 필요한 항목은 절대 지어내지 말고 반드시 null로 남겨줘.\n\n` +
    `응답은 반드시 아래 JSON 형식으로만, 마크다운 백틱이나 다른 설명 없이 순수 JSON만 반환해줘:\n` +
    `{"contractor": string|null, "architect": string|null, "interiorDesigner": string|null, "electricalDesigner": string|null, "mechanicalDesigner": string|null, "supervisor": string|null, "operator": string|null}`;

  const response = await generateContentWithRetry(ai, {
    model: PRIMARY_GEMINI_MODEL,
    contents: prompt,
    config: { tools: [{ googleSearch: {} }] }
  });

  let fields: ProjectRelationsFields = { ...emptyFields };
  try {
    const jsonStr = (response.text || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const parsed = JSON.parse(jsonStr);
    fields = {
      contractor: parsed.contractor || null,
      architect: parsed.architect || null,
      interiorDesigner: parsed.interiorDesigner || null,
      electricalDesigner: parsed.electricalDesigner || null,
      mechanicalDesigner: parsed.mechanicalDesigner || null,
      supervisor: parsed.supervisor || null,
      operator: parsed.operator || null
    };
  } catch (e) {
    console.error('프로젝트 참여사 검색 JSON 파싱 실패:', response.text);
  }

  const sourceUrls: string[] = [];
  try {
    const chunks = (response as unknown as GeminiGroundingResponse)?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    for (const chunk of chunks) {
      const uri = chunk?.web?.uri;
      if (uri && !sourceUrls.includes(uri)) sourceUrls.push(uri);
    }
  } catch (e) {
    // 출처 URL은 있으면 좋고 없어도 치명적이지 않으므로 조용히 넘어간다.
  }

  return { fields, sourceUrls };
}

app.post('/api/projects/relations-search', async (req, res) => {
  try {
    const { projectName, endCustomer, siteLocation } = req.body as { projectName?: string; endCustomer?: string; siteLocation?: string };
    if (!projectName || !projectName.trim()) {
      return res.status(400).json({ error: '프로젝트명이 필요합니다.' });
    }
    const { fields, sourceUrls } = await searchProjectRelations({ projectName, endCustomer, siteLocation });
    res.json({ fields, sourceUrls });
  } catch (error: unknown) {
    console.error('Project relations search error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

// [추가] AI Intelligence의 세 서브탭은 기본적으로 전부 규칙/DB 기반이라 AI 호출이
// 전혀 없다. 사용자가 "정말 궁금할 때만" 아래 버튼을 눌러야 그때 딱 한 번 Gemini를
// 부른다 - 화면을 열자마자 자동으로 도는 게 아니라, 실제 클릭한 만큼만 비용/할당량이
// 나가는 구조로 만들기 위함이다. 세 엔드포인트 다 googleSearch 없이 순수 텍스트
// 분석만 하므로(이미 화면에 보여준 데이터를 그대로 넘겨서 해석/조언만 요청) 검색
// 기반 호출보다 가볍다.
async function runGeminiTextAnalysis(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return 'AI 분석을 사용하려면 GEMINI_API_KEY를 등록해주세요. (지금은 위에 보이는 데이터만으로 판단해주세요)';
  }
  const ai = new GoogleGenAI({ apiKey });
  const response = await generateContentWithRetry(ai, {
    model: PRIMARY_GEMINI_MODEL,
    contents: prompt
  });
  return (response.text || '').trim();
}

app.post('/api/ai-intelligence/briefing-analysis', async (req, res) => {
  try {
    const { briefing } = req.body;
    const prompt = `당신은 업무 비서입니다. 아래는 오늘 하루의 업무 현황 데이터입니다(이미 계산된 데이터이니 다시 계산할 필요 없음):\n\n${JSON.stringify(briefing, null, 2)}\n\n` +
      `이 데이터를 바탕으로, 오늘 가장 먼저 챙겨야 할 것 2~3가지를 우선순위 순서로 짚어주고, 왜 중요한지 짧게 이유를 붙여서 자연스러운 한국어 문장으로 브리핑해줘. ` +
      `인사말이나 formatting 없이, 바로 본론부터 5~7문장 이내로 간결하게 작성해줘.`;
    const analysis = await runGeminiTextAnalysis(prompt);
    res.json({ analysis });
  } catch (error: unknown) {
    console.error('Briefing AI analysis error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

app.post('/api/ai-intelligence/company-analysis', async (req, res) => {
  try {
    const { companies } = req.body;
    const prompt = `당신은 B2B 영업 전략 컨설턴트입니다. 아래는 우리 회사 명함첩에 등록된 거래처 회사들의 정보입니다(이미 조사된 데이터이니 다시 검색할 필요 없음):\n\n${JSON.stringify(companies, null, 2)}\n\n` +
      `이 데이터를 바탕으로, 어느 회사에 우선적으로 집중하면 좋을지, 업종/매출 규모 관점에서 눈에 띄는 특징이나 기회가 있는지 분석해서 자연스러운 한국어 문장으로 정리해줘. ` +
      `인사말이나 formatting 없이, 바로 본론부터 5~7문장 이내로 간결하게 작성해줘.`;
    const analysis = await runGeminiTextAnalysis(prompt);
    res.json({ analysis });
  } catch (error: unknown) {
    console.error('Company AI analysis error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

app.post('/api/ai-intelligence/relationship-analysis', async (req, res) => {
  try {
    const { pipeline, insights, topCompanies } = req.body;
    const prompt = `당신은 영업 관리 컨설턴트입니다. 아래는 우리 회사의 영업 파이프라인과 거래처 관계 데이터입니다(이미 계산된 데이터이니 다시 계산할 필요 없음):\n\n` +
      `파이프라인 요약: ${JSON.stringify(pipeline)}\n\n지금 챙기면 좋은 거래처 목록: ${JSON.stringify(insights)}\n\n관계가 깊은 회사 TOP: ${JSON.stringify(topCompanies)}\n\n` +
      `이 데이터를 바탕으로, 지금 가장 중요한 영업 액션이 무엇인지, 파이프라인에서 위험 신호는 없는지 짚어서 자연스러운 한국어 문장으로 영업 전략을 조언해줘. ` +
      `인사말이나 formatting 없이, 바로 본론부터 5~7문장 이내로 간결하게 작성해줘.`;
    const analysis = await runGeminiTextAnalysis(prompt);
    res.json({ analysis });
  } catch (error: unknown) {
    console.error('Relationship AI analysis error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

// 데이터 전체 입출력을 위한 벌크 업데이트 API
app.post('/api/contacts/import', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const { importedContacts } = req.body;
  if (!Array.isArray(importedContacts)) return res.status(400).json({ error: 'Invalid data' });

  // [수정] 예전엔 "전화번호 같음 OR 이메일 같음" 둘 중 하나만 겹쳐도 무조건 중복으로
  // 봤다. 그런데 회사 대표 이메일 하나를 여러 직원이 같이 쓰는 경우(나래디엔에이 등),
  // 전화번호가 서로 다른 별개 인물인데도 이메일만 같다는 이유로 가져오기가 막히는
  // 문제가 있었다. 이제는 전화번호를 1순위 기준으로 삼는다 — 가져오는 명함에 전화번호가
  // 있으면 전화번호만으로 중복을 판단하고(이메일이 같아도 전화번호가 다르면 별개 인물로
  // 보고 가져온다), 전화번호가 아예 없는 경우에만 이메일을 보조 기준으로 쓴다.
  const normalizePhone = (p?: string) => (p || '').replace(/\D/g, '');
  const existingPhoneKeys = new Set<string>();
  const existingEmailKeys = new Set<string>();
  // [추가] "0건 가져옴, N건 중복 건너뜀"이라고만 알려주면, 사용자가 그 기존 명함을
  // 이름/회사가 다르게 저장돼 있어서 못 찾는 경우 답답해했다. 어느 전화번호/이메일이
  // 어떤 기존 명함(이름)과 겹쳤는지 같이 돌려줘서, 결과 메시지에서 바로 확인할 수 있게 한다.
  const keyToExistingContact = new Map<string, { id: string; name: string }>();
  for (const c of dbData.contacts) {
    if (c.phoneMobile) {
      const k = `phone:${normalizePhone(c.phoneMobile)}`;
      existingPhoneKeys.add(k);
      if (!keyToExistingContact.has(k)) keyToExistingContact.set(k, { id: c.id, name: c.name || '(이름 없음)' });
    }
    if (c.email) {
      const k = `email:${c.email.trim().toLowerCase()}`;
      existingEmailKeys.add(k);
      if (!keyToExistingContact.has(k)) keyToExistingContact.set(k, { id: c.id, name: c.name || '(이름 없음)' });
    }
  }

  const toInsert: any[] = [];
  let skippedDuplicates = 0;
  const skippedDetails: { importedName: string; matchedField: 'phone' | 'email'; existingContactId: string; existingContactName: string }[] = [];

  for (const c of importedContacts as any[]) {
    const phoneKey = c.phoneMobile && normalizePhone(c.phoneMobile) ? `phone:${normalizePhone(c.phoneMobile)}` : null;
    const emailKey = c.email && c.email.trim() ? `email:${c.email.trim().toLowerCase()}` : null;
    // 전화번호가 있으면 전화번호만으로 판단(이메일은 무시), 전화번호가 없을 때만 이메일로 판단
    const matchedKey = phoneKey
      ? (existingPhoneKeys.has(phoneKey) ? phoneKey : null)
      : (emailKey && existingEmailKeys.has(emailKey) ? emailKey : null);
    if (matchedKey) {
      skippedDuplicates += 1;
      const existing = keyToExistingContact.get(matchedKey);
      if (existing) {
        skippedDetails.push({
          importedName: c.name || '(이름 없음)',
          matchedField: matchedKey.startsWith('phone:') ? 'phone' : 'email',
          existingContactId: existing.id,
          existingContactName: existing.name
        });
      }
      continue;
    }

    if (!c.id) c.id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (!c.createdAt) c.createdAt = new Date().toISOString();
    if (!c.callHistory) c.callHistory = [];
    // [수정] 예전엔 그룹 정보가 없으면 그룹 목록의 "첫 번째 그룹"(보통 VIP 거래처)에 강제로
    // 넣었는데, 관리자가 그룹 순서를 바꾸면 기본값도 같이 바뀌는 데다가, 가져온 명함이
    // 의도치 않게 특정 그룹으로 분류되는 게 헷갈린다는 의견이 있었다. 이제는 그룹 정보가
    // 없거나(파일에 없음) 우리 쪽에 존재하지 않는 그룹이면, 그냥 그룹을 비워둔다 — "전체보기"
    // 에서는 보이지만 특정 그룹 필터에는 안 걸리는 상태. 필요하면 나중에 직접 그룹을 지정하면 된다.
    if (c.groupId && !dbData.groups.some(g => g.id === c.groupId)) {
      c.groupId = undefined;
    }
    // [수정] 가져오기는 한 번에 수백~수천 건이 될 수 있어서, 건마다 실시간으로 지오코딩
    // API를 부르면 너무 느려지고(가져오기 자체가 타임아웃 날 위험) 카카오 API 사용량
    // 제한에도 쉽게 걸린다. 그래서 가져온 명함은 좌표를 비워둔 채로 저장하고(주변 레이더
    // 지도엔 안 보임), 나중에 그 명함을 한 번 수정해서 저장하면 그때 실제 좌표가 채워진다.
    // 틀린 좌표를 억지로 채우는 것보다, 정직하게 비워두는 쪽을 택했다.
    // [수정] 가져온 연락처에 자동 생성된 명함 이미지(base64)가 붙어있는 경우, 다른 명함 등록
    // 경로와 동일하게 Storage에 업로드하고 URL만 저장한다 (DB에 원본 base64를 그대로
    // 넣으면 용량이 커지고, 다른 경로로 등록된 명함들과 저장 방식이 달라져버린다).
    c.frontImage = await persistImageField(scopeId, c.frontImage, `contact-${c.id}-front`);
    c.backImage = await persistImageField(scopeId, c.backImage, `contact-${c.id}-back`);
    dbData.contacts.unshift(c);
    toInsert.push(c);

    if (phoneKey) existingPhoneKeys.add(phoneKey);
    if (emailKey) existingEmailKeys.add(emailKey);
  }

  // [수정] 가져오기 도중 DB 저장이 실패하면, 방금 메모리에 추가한 항목들(toInsert)을 모두
  // 되돌리고 실패를 알린다 — 그렇지 않으면 "가져오기 완료"로 보이지만 실제로는 DB에 없는
  // 명함들이 화면에만 잠깐 보이다가 서버 재시작 시 사라지는 문제가 생긴다.
  const bulkSaved = await setScopedDocs(scopeId, 'contacts', toInsert);
  if (!bulkSaved) {
    const insertedIds = new Set(toInsert.map((c) => c.id));
    dbData.contacts = dbData.contacts.filter((c: BusinessCard) => !insertedIds.has(c.id));
    return res.status(500).json({ error: '가져온 명함을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json({ count: toInsert.length, skippedDuplicates, skippedDetails, contacts: dbData.contacts });
});

// 내 명함 프로필 API
app.get('/api/my-profile', async (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);

  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const dbData = getScopedData(req);
  const myProfile = (dbData.myProfile || {
    name: '', company: '', department: '', title: '',
    phoneMobile: '', phoneOffice: '', phoneFax: '', email: '',
    address: '', snsUrl: '', website: '', memo: ''
  }) as MyProfile;

  // [수정] 공유 랜딩 페이지(/s/:slug)용 공개 식별자가 없으면 최초 조회 시 자동 생성해서 저장한다.
  if (!myProfile.shareSlug) {
    myProfile.shareSlug = crypto.randomBytes(6).toString('hex');
    await setScopedProfile(req.scopeId, myProfile);
  }
  res.json(myProfile);
});

app.put('/api/my-profile', async (req, res) => {
  // ✅ 데이터 수정 Rate Limiting
  if (!checkModifyRateLimit(req, res)) return;

  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  // [추가] DB 저장 실패 시 메모리 캐시를 되돌리기 위해 수정 전 값을 남겨둔다.
  const previousProfile = dbData.myProfile;
  dbData.myProfile = { ...dbData.myProfile, ...req.body };
  // [수정] 내 명함 사진도 마찬가지로 Storage에 업로드 후 URL만 저장
  dbData.myProfile.frontImage = await persistImageField(scopeId, dbData.myProfile.frontImage, `myprofile-${scopeId}-front`);
  dbData.myProfile.backImage = await persistImageField(scopeId, dbData.myProfile.backImage, `myprofile-${scopeId}-back`);
  // [수정] "내 명함"도 재스캔한 사진이 DB 저장에 실패했는데 조용히 성공으로 응답하던 문제를
  // 고쳤다. 실패하면 메모리를 원래대로 되돌리고 에러를 알린다.
  const savedProfile = await setScopedProfile(scopeId, dbData.myProfile);
  if (!savedProfile) {
    dbData.myProfile = previousProfile;
    return res.status(500).json({ error: '내 명함 정보를 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(dbData.myProfile);
});

// ------------------------------------------------------------------
// 🧩 회사별 결재선 기본 템플릿 (전자결재)
// 회사마다 결재 단계/직책명이 다를 수 있어, 새 문서 작성 시 자동으로 채워질
// "우리 회사 기본 결재선"을 회사(스코프) 단위로 저장/조회한다.
// 저장된 템플릿이 없으면 null을 내려주고, 프론트에서 내장 기본값을 사용한다.
// ------------------------------------------------------------------
app.get('/api/approval-line-templates', async (req, res) => {
  const scopeId = req.scopeId;
  const existing = await getScopedDoc<{ id: string; advance?: ApprovalStep[]; leave?: ApprovalStep[]; official?: ApprovalStep[] }>(scopeId, 'approvalLineTemplates', 'default');
  res.json(existing || { id: 'default', advance: null, leave: null, official: null });
});

// [수정] 결재선 기본 템플릿은 회사 전체의 결재 흐름(예: 대표이사 결재 단계 포함 여부)을
// 좌우하므로, 조회(GET)는 회사 소속 누구나 가능하지만 저장(PUT)은 관리자만 할 수 있어야
// 한다. 이 체크가 빠져 있으면 일반 직원도 결재선을 마음대로 바꿔버릴 수 있었다.
app.put('/api/approval-line-templates', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const scopeId = req.scopeId;
  const template = { id: 'default', advance: req.body.advance || null, leave: req.body.leave || null, official: req.body.official || null };
  await setScopedDoc(scopeId, 'approvalLineTemplates', template);
  res.json(template);
});

// ------------------------------------------------------------------
// 🖼️ 회사별 공문서 로고 / 직인
// 예전엔 공문서 상단 로고와 하단 직인(도장) 이미지가 "카이저솔루션" 것으로
// 하드코딩되어 있었다. 이제 회사(스코프)마다 각자 업로드해서 자기 공문서에만
// 반영되도록 한다. 조회는 회사 소속 누구나, 저장(업로드/삭제)은 관리자만 가능하다.
// ------------------------------------------------------------------
app.get('/api/company-branding', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const scopeId = req.scopeId;
  const existing = await getScopedDoc<CompanyBranding>(scopeId, 'branding', 'branding');
  res.json(existing || { id: 'branding', scopeId, logoUrl: undefined, sealUrl: undefined, updatedAt: '' });
});

app.put('/api/company-branding', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const scopeId = req.scopeId;

  const existing = await getScopedDoc<CompanyBranding>(scopeId, 'branding', 'branding');
  let logoUrl = existing?.logoUrl;
  let sealUrl = existing?.sealUrl;

  const { logoImage, sealImage, removeLogo, removeSeal } = req.body;
  if (removeLogo) logoUrl = undefined;
  if (removeSeal) sealUrl = undefined;
  if (typeof logoImage === 'string' && logoImage.startsWith('data:image/')) {
    logoUrl = await persistImageField(scopeId, logoImage, `branding-logo-${scopeId}`, 'branding');
  }
  if (typeof sealImage === 'string' && sealImage.startsWith('data:image/')) {
    sealUrl = await persistImageField(scopeId, sealImage, `branding-seal-${scopeId}`, 'branding');
  }

  const branding: CompanyBranding = { id: 'branding', scopeId, logoUrl, sealUrl, updatedAt: new Date().toISOString() };
  const saved = await setScopedDoc(scopeId, 'branding', branding);
  if (!saved) {
    return res.status(500).json({ error: '로고/직인 이미지를 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(branding);
});

// ------------------------------------------------------------------
// 🔗 공유 랜딩 페이지 (누구나 로그인 없이 접근 가능한 공개 페이지)
// 카카오톡/트위터/링크드인 등에 이 링크를 공유하면, 아래 og:title/description/image
// 메타태그를 각 플랫폼이 자동으로 긁어가 예쁜 미리보기 카드를 만들어준다.
// ------------------------------------------------------------------
function escapeHtml(str: string): string {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c
  ));
}

// [추가] slug 경로 검증: 영숫자, 대시(-), 언더스코어(_)만 허용하여 경로 트래버설 공격 방지
const VALID_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

app.get('/s/:slug', async (req, res) => {
  try {
    // [추가] slug 형식 검증 - 예상치 못한 특수문자나 경로 트래버설(.., /, 등) 방지
    const slug = req.params.slug;
    if (!VALID_SLUG_PATTERN.test(slug)) {
      return res.status(400).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;">잘못된 요청입니다.</h1>');
    }

    const result = await findProfileByShareSlug(slug);
    if (!result) {
      return res.status(404).send('<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;">명함을 찾을 수 없습니다.</h1>');
    }
    const { profile } = result;
    const title = `${profile.name} · ${profile.company}`;
    const description = `${profile.title}${profile.department ? ' | ' + profile.department : ''} · 📞 ${profile.phoneMobile}`;
    const hasPhoto = !!profile.frontImage;
    const imageUrl = hasPhoto
      ? `${APP_BASE_URL}/s/${req.params.slug}/photo`
      : `${APP_BASE_URL}/kakao-share-thumb.png`;
    const pageUrl = `${APP_BASE_URL}/s/${req.params.slug}`;

    res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${imageUrl}" />
<meta property="og:url" content="${pageUrl}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${imageUrl}" />
<style>
  body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; background:#0f172a; color:#e2e8f0; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; box-sizing:border-box; }
  .card { background:#1e293b; border-radius:24px; padding:32px; max-width:420px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.4); box-sizing:border-box; }
  .card img { width:100%; border-radius:16px; margin-bottom:20px; display:block; }
  h1 { font-size:22px; margin:0 0 4px; }
  .title { color:#60a5fa; font-size:13px; margin-bottom:16px; }
  .row { font-size:14px; margin:8px 0; color:#cbd5e1; }
  a { color:#93c5fd; text-decoration:none; }
  .badge { display:inline-block; margin-top:20px; font-size:11px; color:#64748b; }
</style>
</head>
<body>
  <div class="card">
    ${hasPhoto ? `<img src="${imageUrl}" alt="명함" />` : ''}
    <h1>${escapeHtml(profile.name)}</h1>
    <div class="title">${escapeHtml(profile.title)}${profile.company ? ' · ' + escapeHtml(profile.company) : ''}</div>
    ${profile.phoneMobile ? `<div class="row">📱 <a href="tel:${escapeHtml(profile.phoneMobile)}">${escapeHtml(profile.phoneMobile)}</a></div>` : ''}
    ${profile.email ? `<div class="row">✉️ <a href="mailto:${escapeHtml(profile.email)}">${escapeHtml(profile.email)}</a></div>` : ''}
    ${profile.address ? `<div class="row">🏢 ${escapeHtml(profile.address)}</div>` : ''}
    ${profile.website ? `<div class="row">🌐 <a href="${escapeHtml(profile.website)}" target="_blank" rel="noreferrer">${escapeHtml(profile.website)}</a></div>` : ''}
    <div class="badge">BizCard 디지털 명함</div>
  </div>
</body>
</html>`);
  } catch (error: unknown) {
    console.error('공유 페이지 오류:', error);
    res.status(500).send('오류가 발생했습니다.');
  }
});

// 공유 페이지용 명함 사진: base64로 저장된 사진을 실제 이미지 응답으로 변환해서 내려준다.
// (카카오톡/트위터 등은 og:image에 실제 접근 가능한 이미지 URL을 요구하며 data: URI는 인식하지 못한다)
app.get('/s/:slug/photo', async (req, res) => {
  try {
    const result = await findProfileByShareSlug(req.params.slug);
    if (!result || !result.profile.frontImage) return res.status(404).end();

    // [수정] 이제 frontImage는 base64가 아니라 Supabase Storage의 실제 URL인 경우가 대부분이다.
    // URL이면 그 주소로 바로 리다이렉트해서 보여주고, 예전 방식(base64)으로 저장된 옛 데이터도
    // 계속 문제없이 보이도록 두 경우 모두 지원한다.
    if (/^https?:\/\//.test(result.profile.frontImage)) {
      return res.redirect(302, result.profile.frontImage);
    }

    const match = result.profile.frontImage.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(404).end();
    const [, mime, base64Data] = match;
    const buffer = Buffer.from(base64Data, 'base64');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (error) {
    console.error('공유 사진 오류:', error);
    res.status(500).end();
  }
});

// 프로젝트 CRUD API
app.get('/api/projects', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);

  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const dbData = getScopedData(req);
  res.json(dbData.projects || []);
});

app.post('/api/projects', async (req, res) => {
  const dbData = getScopedData(req);
  const p: Project = req.body;
  if (!p.id) p.id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!p.createdAt) p.createdAt = new Date().toISOString();
  if (!p.followUps) p.followUps = [];
  if (!p.contactIds) p.contactIds = [];
  dbData.projects.unshift(p);
  await setScopedDoc(req.scopeId, 'projects', p);
  res.status(201).json(p);
});

// [추가] 엑셀(특약점 프로젝트 파이프라인 등)에서 정리해둔 여러 프로젝트를 한 번에 등록하는
// 일괄 가져오기. 한 건씩 등록해야 했던 기존 방식과 달리, 프론트에서 엑셀을 읽어 이 형식의
// 배열로 만들어 보내면 한 번에 저장한다. 단건 등록(app.post('/api/projects'))과 동일한
// 기본값 채우기 규칙을 그대로 따른다.
app.post('/api/projects/import', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const importedProjects = req.body.importedProjects;
  if (!Array.isArray(importedProjects)) {
    return res.status(400).json({ error: 'importedProjects 배열이 필요합니다.' });
  }

  const toInsert: Project[] = [];
  for (const raw of importedProjects as any[]) {
    const p: Project = {
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name: raw.name || '(이름 없음)',
      description: raw.description || '',
      salesRep: raw.salesRep || '',
      developer: raw.developer || '',
      status: raw.status || 'opportunity',
      priority: raw.priority || 'medium',
      dueDate: raw.dueDate || '',
      contactIds: [],
      budget: raw.budget || '',
      followUps: [],
      createdAt: new Date().toISOString(),
      // [추가] "프로젝트 파이프라인" 양식 전용 필드들(리스트 출력 화면/인쇄/엑셀에서 사용).
      // 클라이언트(ProjectsView.tsx의 handleImportProjectsExcel)가 엑셀에서 읽어 그대로
      // 넣어 보내므로 여기서도 빠짐없이 저장한다.
      endCustomer: raw.endCustomer || '',
      siteLocation: raw.siteLocation || '',
      productGroup: raw.productGroup || '',
      mainItemsSpec: raw.mainItemsSpec || '',
      expectedTiming: raw.expectedTiming || '',
      winProbability: typeof raw.winProbability === 'number' ? raw.winProbability : undefined,
      pipelineStage: raw.pipelineStage || undefined,
      competitor: raw.competitor || '',
      supportNeeded: raw.supportNeeded || '',
      remarks: raw.remarks || ''
    };
    dbData.projects.unshift(p);
    toInsert.push(p);
  }

  await setScopedDocs(scopeId, 'projects', toInsert);
  res.status(201).json({ count: toInsert.length, projects: dbData.projects });
});

app.put('/api/projects/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const idx = dbData.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  dbData.projects[idx] = { ...dbData.projects[idx], ...req.body };
  await setScopedDoc(req.scopeId, 'projects', dbData.projects[idx]);
  res.json(dbData.projects[idx]);
});

app.delete('/api/projects/:id', async (req, res) => {
  const dbData = getScopedData(req);
  dbData.projects = dbData.projects.filter(p => p.id !== req.params.id);
  await deleteScopedDoc(req.scopeId, 'projects', req.params.id);
  res.json({ success: true });
});

// [추가] "리스트 출력" 표에서 여러 프로젝트를 한 번에 선택/전체 삭제할 때 쓰는 일괄 삭제
// API. 기존 단건 삭제(app.delete('/api/projects/:id'))를 배열로 반복 호출하는 것과 동일한
// 효과지만, 요청 한 번으로 처리해 다건 삭제 시 네트워크 왕복을 줄인다.
app.post('/api/projects/bulk-delete', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length === 0) return res.json({ success: true, deletedCount: 0 });
  const idSet = new Set(ids);
  dbData.projects = dbData.projects.filter(p => !idSet.has(p.id));
  for (const id of ids) {
    await deleteScopedDoc(scopeId, 'projects', id);
  }
  res.json({ success: true, deletedCount: ids.length });
});

// 프로젝트 팔로우업 노트 관리
app.post('/api/projects/:id/followups', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const idx = dbData.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  
  const f: ProjectFollowUp = {
    id: `f-${Date.now()}`,
    projectId: req.params.id,
    content: req.body.content || '',
    date: req.body.date || new Date().toISOString().split('T')[0],
    status: req.body.status || 'planned',
    meetingDegree: req.body.meetingDegree,
    meetingType: req.body.meetingType,
    attendee: req.body.attendee,
    internalStaffName: req.body.internalStaffName,
    hasVoice: req.body.hasVoice,
    voiceUrl: req.body.voiceUrl,
    voiceDuration: req.body.voiceDuration,
    attachments: req.body.attachments || [],
    expenses: req.body.expenses || []
  };
  // [수정] 미팅 지출 영수증 사진들을 Storage에 업로드 후 URL로 교체
  f.expenses = await persistReceiptImagesInArray(scopeId, f.expenses, `followup-${f.id}`);
  // [추가] 첨부파일(제안서/견적서 등, PDF·PPT·엑셀·한글 포함)도 Storage에 업로드 후 URL로 교체
  f.attachments = await persistAttachmentsInArray(scopeId, f.attachments, `followup-${f.id}`);
  // [추가] DB 저장 실패 시 되돌리기 위해 수정 전 프로젝트 상태를 남겨둔다.
  const previousProject = dbData.projects[idx];
  dbData.projects[idx] = { ...previousProject, followUps: [f, ...previousProject.followUps] };
  // [수정] 영수증/첨부파일이 포함된 미팅 기록은 용량이 커서 DB 저장이 실패하기 쉬운데도
  // 조용히 "성공"으로 응답하던 문제를 고쳤다. 실패하면 되돌리고 에러를 알린다.
  const savedFollowup = await setScopedDoc(scopeId, 'projects', dbData.projects[idx]);
  if (!savedFollowup) {
    dbData.projects[idx] = previousProject;
    return res.status(500).json({ error: '미팅 기록을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(dbData.projects[idx]);
});

app.put('/api/projects/:id/followups/:fid', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const idx = dbData.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  
  const fIdx = dbData.projects[idx].followUps.findIndex(f => f.id === req.params.fid);
  if (fIdx !== -1) {
    const updatedFollowUp = { ...dbData.projects[idx].followUps[fIdx], ...req.body };
    if (req.body.expenses) {
      updatedFollowUp.expenses = await persistReceiptImagesInArray(scopeId, updatedFollowUp.expenses, `followup-${req.params.fid}`);
    }
    if (req.body.attachments) {
      updatedFollowUp.attachments = await persistAttachmentsInArray(scopeId, updatedFollowUp.attachments, `followup-${req.params.fid}`);
    }
    // [추가] DB 저장 실패 시 되돌리기 위해 수정 전 프로젝트 상태를 남겨둔다.
    const previousProject = dbData.projects[idx];
    const nextFollowUps = [...previousProject.followUps];
    nextFollowUps[fIdx] = updatedFollowUp;
    dbData.projects[idx] = { ...previousProject, followUps: nextFollowUps };
    // [수정] 위 등록(POST)과 동일한 이유로, 저장 실패를 조용히 넘기지 않고 되돌린 뒤 알린다.
    const savedFollowup = await setScopedDoc(scopeId, 'projects', dbData.projects[idx]);
    if (!savedFollowup) {
      dbData.projects[idx] = previousProject;
      return res.status(500).json({ error: '미팅 기록 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
    }
  }
  res.json(dbData.projects[idx]);
});

app.delete('/api/projects/:id/followups/:fid', async (req, res) => {
  const dbData = getScopedData(req);
  const idx = dbData.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  
  dbData.projects[idx].followUps = dbData.projects[idx].followUps.filter(f => f.id !== req.params.fid);
  await setScopedDoc(req.scopeId, 'projects', dbData.projects[idx]);
  res.json(dbData.projects[idx]);
});

// ==========================================
// 🚗 통합 차량 관리 CRUD API (Vehicle Management)
// ==========================================

app.get('/api/vehicles', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);

  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  // DB에서 사용자의 vehicles 데이터 직접 로드
  const dbData = getScopedData(req);
  res.json(dbData.vehicles || []);
});

app.post('/api/vehicles', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const v: Vehicle = req.body;
  if (!v.id) v.id = `vh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!v.createdAt) v.createdAt = new Date().toISOString();
  if (v.currentMileage === undefined) v.currentMileage = v.initialMileage || 0;
  // [수정] 자동차 등록증 사진/파일이 base64로 들어오면 Storage에 올리고 URL만 저장한다
  // (명함 사진 등 다른 필드는 이미 이렇게 처리되고 있었는데, 이 필드만 빠져 있었다).
  v.registrationDocumentUrl = await persistFileField(scopeId, v.registrationDocumentUrl, `vehicle-${v.id}-reg`, 'attachments');

  dbData.vehicles.unshift(v);
  // [수정] 등록증 스캔본이 포함된 저장이 DB에 실제로 실패했는데도 조용히 "성공"으로
  // 응답하던 문제를 고쳤다. 실패하면 방금 추가한 것을 되돌리고 알린다.
  const savedVehicle = await setScopedDoc(scopeId, 'vehicles', v);
  if (!savedVehicle) {
    dbData.vehicles = dbData.vehicles.filter((x: Vehicle) => x.id !== v.id);
    return res.status(500).json({ error: '차량 정보를 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(v);
});

app.put('/api/vehicles/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const idx = dbData.vehicles.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Vehicle not found' });

  const previousVehicle = dbData.vehicles[idx];
  const updated = { ...dbData.vehicles[idx], ...req.body };
  // [수정] 위와 동일: 수정 화면에서 등록증을 새로 올린 경우에도 Storage로 옮긴다.
  updated.registrationDocumentUrl = await persistFileField(scopeId, updated.registrationDocumentUrl, `vehicle-${updated.id}-reg`, 'attachments');
  dbData.vehicles[idx] = updated;
  // [수정] 위 등록(POST)과 동일한 이유로, 저장 실패를 조용히 넘기지 않고 되돌린 뒤 알린다.
  const savedVehicle = await setScopedDoc(scopeId, 'vehicles', dbData.vehicles[idx]);
  if (!savedVehicle) {
    dbData.vehicles[idx] = previousVehicle;
    return res.status(500).json({ error: '차량 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(dbData.vehicles[idx]);
});

app.delete('/api/vehicles/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.vehicles = dbData.vehicles.filter(v => v.id !== req.params.id);
  dbData.drivingLogs = dbData.drivingLogs.filter(log => log.vehicleId !== req.params.id);
  dbData.expenses = dbData.expenses.filter(e => e.vehicleId !== req.params.id);
  dbData.maintenances = dbData.maintenances.filter(m => m.vehicleId !== req.params.id);
  await Promise.all([
    deleteScopedDoc(scopeId, 'vehicles', req.params.id),
    replaceScopedCollection(scopeId, 'drivingLogs', dbData.drivingLogs),
    replaceScopedCollection(scopeId, 'expenses', dbData.expenses),
    replaceScopedCollection(scopeId, 'maintenances', dbData.maintenances)
  ]);
  res.json({ success: true });
});

// === 운행기록 API ===
app.get('/api/vehicles/driving', (req, res) => {
  const dbData = getScopedData(req);
  res.json(dbData.drivingLogs || []);
});

app.post('/api/vehicles/driving', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const log: DrivingLog = req.body;
  if (!log.id) log.id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!log.createdAt) log.createdAt = new Date().toISOString();
  
  dbData.drivingLogs.unshift(log);

  // 주행 로그 등록 시 해당 차량의 현재 주행거리 갱신
  const vIdx = dbData.vehicles.findIndex(v => v.id === log.vehicleId);
  let updatedVehicle: Vehicle | null = null;
  if (vIdx !== -1) {
    const v = dbData.vehicles[vIdx];
    if (log.endMileage > v.currentMileage) {
      dbData.vehicles[vIdx].currentMileage = log.endMileage;
      updatedVehicle = dbData.vehicles[vIdx];
    }
  }

  await setScopedDoc(scopeId, 'drivingLogs', log);
  if (updatedVehicle) await setScopedDoc(scopeId, 'vehicles', updatedVehicle);
  res.status(201).json(log);
});

app.delete('/api/vehicles/driving/:id', async (req, res) => {
  const dbData = getScopedData(req);
  dbData.drivingLogs = dbData.drivingLogs.filter(log => log.id !== req.params.id);
  await deleteScopedDoc(req.scopeId, 'drivingLogs', req.params.id);
  res.json({ success: true });
});

// === 지출비용 API ===
app.get('/api/vehicles/expenses', (req, res) => {
  const dbData = getScopedData(req);
  res.json(dbData.expenses || []);
});

app.post('/api/vehicles/expenses', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const exp: VehicleExpense = req.body;
  // [수정] 예전엔 서버가 id를 자동으로 채울 때 `exp-${Date.now()}`처럼 밀리초 타임스탬프만
  // 썼다. 운행일지 하나에 영수증을 여러 개 연달아 등록하거나, 같은 요청이 겹치는 경우
  // 같은 밀리초에 두 건이 만들어지면 id가 완전히 같아져서, DB에 저장할 때
  // "duplicate key" 에러로 저장이 실패하는 문제가 있었다. 다른 곳(ProjectsView의 미팅
  // 비용 등)에서 이미 쓰던 것과 같이 무작위 문자열을 붙여서 충돌 가능성을 없앤다.
  if (!exp.id) exp.id = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!exp.createdAt) exp.createdAt = new Date().toISOString();
  exp.receiptImage = await persistImageField(scopeId, exp.receiptImage, `vehicle-expense-${exp.id}`, 'receipts');

  dbData.expenses.unshift(exp);
  // [수정] 영수증 스캔본이 포함된 저장이 DB에 실제로 실패했는데도 조용히 "성공"으로
  // 응답하던 문제를 고쳤다. 실패하면 방금 추가한 것을 되돌리고 알린다.
  const savedExpense = await setScopedDoc(scopeId, 'expenses', exp);
  if (!savedExpense) {
    dbData.expenses = dbData.expenses.filter((e: VehicleExpense) => e.id !== exp.id);
    return res.status(500).json({ error: '지출 내역을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(exp);
});

app.delete('/api/vehicles/expenses/:id', async (req, res) => {
  const dbData = getScopedData(req);
  dbData.expenses = dbData.expenses.filter(e => e.id !== req.params.id);
  await deleteScopedDoc(req.scopeId, 'expenses', req.params.id);
  res.json({ success: true });
});

// === 정비기록 API ===
app.get('/api/vehicles/maintenances', (req, res) => {
  const dbData = getScopedData(req);
  res.json(dbData.maintenances || []);
});

app.post('/api/vehicles/maintenances', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const maint: VehicleMaintenance = req.body;
  if (!maint.id) maint.id = `maint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!maint.createdAt) maint.createdAt = new Date().toISOString();
  maint.receiptImage = await persistImageField(scopeId, maint.receiptImage, `vehicle-maint-${maint.id}`, 'receipts');

  dbData.maintenances.unshift(maint);
  // [수정] 위 지출비용과 동일한 이유로, 영수증 스캔본이 포함된 저장 실패를 조용히 넘기지
  // 않고 되돌린 뒤 알린다.
  const savedMaint = await setScopedDoc(scopeId, 'maintenances', maint);
  if (!savedMaint) {
    dbData.maintenances = dbData.maintenances.filter((m: VehicleMaintenance) => m.id !== maint.id);
    return res.status(500).json({ error: '정비 기록을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(maint);
});

app.put('/api/vehicles/maintenances/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const idx = dbData.maintenances.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Maintenance not found' });

  const previousMaint = dbData.maintenances[idx];
  const updated = { ...dbData.maintenances[idx], ...req.body };
  updated.receiptImage = await persistImageField(scopeId, updated.receiptImage, `vehicle-maint-${updated.id}`, 'receipts');
  dbData.maintenances[idx] = updated;
  const savedMaintUpdate = await setScopedDoc(scopeId, 'maintenances', dbData.maintenances[idx]);
  if (!savedMaintUpdate) {
    dbData.maintenances[idx] = previousMaint;
    return res.status(500).json({ error: '정비 기록 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(dbData.maintenances[idx]);
});

app.delete('/api/vehicles/maintenances/:id', async (req, res) => {
  const dbData = getScopedData(req);
  dbData.maintenances = dbData.maintenances.filter(m => m.id !== req.params.id);
  await deleteScopedDoc(req.scopeId, 'maintenances', req.params.id);
  res.json({ success: true });
});

// === 운행기록 수정 API ===
app.put('/api/vehicles/driving/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const idx = dbData.drivingLogs.findIndex(log => log.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Driving log not found' });

  // [추가] 이 기록의 "도착 계기판"을 실제 계기판 값으로 수정하는 경우, 원래 이 기록의
  // 도착값을 그대로 이어받아 "출발 계기판"으로 썼던 다음 기록이 있다면 그 값도 같이
  // 맞춰줘야 한다 — 안 그러면 두 기록 사이에 몇 km가 붕 뜨거나 겹쳐버린다.
  const oldEndMileage = dbData.drivingLogs[idx].endMileage;

  dbData.drivingLogs[idx] = { ...dbData.drivingLogs[idx], ...req.body };
  
  const log = dbData.drivingLogs[idx];
  const vIdx = dbData.vehicles.findIndex(v => v.id === log.vehicleId);
  let updatedVehicle: Vehicle | null = null;
  if (vIdx !== -1) {
    const v = dbData.vehicles[vIdx];
    if (log.endMileage > v.currentMileage) {
      dbData.vehicles[vIdx].currentMileage = log.endMileage;
      updatedVehicle = dbData.vehicles[vIdx];
    }
  }
  await setScopedDoc(scopeId, 'drivingLogs', log);
  if (updatedVehicle) await setScopedDoc(scopeId, 'vehicles', updatedVehicle);

  // 도착 계기판이 바뀌었으면, 이어지는 다음 기록(출발 계기판 = 이 기록의 원래 도착 계기판)을
  // 찾아서 그 출발 계기판과 주행거리도 같이 맞춰준다.
  let cascadedLog: DrivingLog | null = null;
  if (log.endMileage !== oldEndMileage) {
    const nextIdx = dbData.drivingLogs.findIndex(
      (l) => l.id !== log.id && l.vehicleId === log.vehicleId && l.startMileage === oldEndMileage
    );
    if (nextIdx !== -1) {
      const nextLog = dbData.drivingLogs[nextIdx];
      const newDistance = nextLog.endMileage - log.endMileage;
      // 다음 기록의 도착 계기판보다 새 출발 계기판이 더 커지면(주행거리가 음수가 되면)
      // 자동으로 맞추지 않고 그대로 둔다 — 사용자가 직접 확인하고 고치는 게 안전하다.
      if (newDistance >= 0) {
        dbData.drivingLogs[nextIdx] = { ...nextLog, startMileage: log.endMileage, distance: newDistance };
        cascadedLog = dbData.drivingLogs[nextIdx];
        await setScopedDoc(scopeId, 'drivingLogs', cascadedLog);
      }
    }
  }

  res.json({ ...dbData.drivingLogs[idx], cascadedLog });
});

// === 지출비용 수정 API ===
app.put('/api/vehicles/expenses/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const idx = dbData.expenses.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Expense not found' });
  const previousExpense = dbData.expenses[idx];
  const updated = { ...dbData.expenses[idx], ...req.body };
  updated.receiptImage = await persistImageField(scopeId, updated.receiptImage, `vehicle-expense-${updated.id}`, 'receipts');
  dbData.expenses[idx] = updated;
  const savedExpenseUpdate = await setScopedDoc(scopeId, 'expenses', dbData.expenses[idx]);
  if (!savedExpenseUpdate) {
    dbData.expenses[idx] = previousExpense;
    return res.status(500).json({ error: '지출 내역 수정 사항을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(dbData.expenses[idx]);
});

// === 점검 주기 설정 API ===
app.get('/api/vehicles/intervals', (req, res) => {
  const dbData = getScopedData(req);
  res.json(dbData.maintenanceIntervals || []);
});

app.post('/api/vehicles/intervals', async (req, res) => {
  const dbData = getScopedData(req);
  const interval: MaintenanceInterval = req.body;
  if (!interval.id) interval.id = `int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!interval.createdAt) interval.createdAt = new Date().toISOString();
  dbData.maintenanceIntervals = dbData.maintenanceIntervals || [];
  dbData.maintenanceIntervals.unshift(interval);
  await setScopedDoc(req.scopeId, 'maintenanceIntervals', interval);
  res.status(201).json(interval);
});

app.put('/api/vehicles/intervals/:id', async (req, res) => {
  const dbData = getScopedData(req);
  dbData.maintenanceIntervals = dbData.maintenanceIntervals || [];
  const idx = dbData.maintenanceIntervals.findIndex(item => item.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Interval not found' });
  dbData.maintenanceIntervals[idx] = { ...dbData.maintenanceIntervals[idx], ...req.body };
  await setScopedDoc(req.scopeId, 'maintenanceIntervals', dbData.maintenanceIntervals[idx]);
  res.json(dbData.maintenanceIntervals[idx]);
});

app.delete('/api/vehicles/intervals/:id', async (req, res) => {
  const dbData = getScopedData(req);
  dbData.maintenanceIntervals = dbData.maintenanceIntervals || [];
  dbData.maintenanceIntervals = dbData.maintenanceIntervals.filter(item => item.id !== req.params.id);
  await deleteScopedDoc(req.scopeId, 'maintenanceIntervals', req.params.id);
  res.json({ success: true });
});

// === 업무일지 (Work Logs) API ===

// 업무일지 비용과 차량 비용 관리 동기화 헬퍼 함수
function syncWorkLogExpenses(dbData: ScopedData, logId: string, logDate: string, logTitle: string, expenses: WorkLogExpense[] | undefined) {
  dbData.expenses = dbData.expenses || [];
  // 해당 업무일지로부터 등록되었던 기존 연동 차량 비용 내역 제거
  dbData.expenses = dbData.expenses.filter((e) => !e.id.startsWith(`ve-wl-${logId}-`));

  if (!expenses || !Array.isArray(expenses)) return;

  expenses.forEach((expense) => {
    if (!expense.vehicleId) return; // 차량 연동 선택이 안 된 지출은 건너뜀

    // 카테고리 매핑
    let category: VehicleExpense['category'] = 'other';
    let memoPrefix = '';

    switch (expense.category) {
      case 'breakfast':
        category = 'meal';
        memoPrefix = '[아침식사] ';
        break;
      case 'lunch':
        category = 'meal';
        memoPrefix = '[점심식사] ';
        break;
      case 'dinner':
        category = 'meal';
        memoPrefix = '[저녁식사] ';
        break;
      case 'drinks':
        category = 'beverage';
        memoPrefix = '[음료&커피] ';
        break;
      case 'fuel':
        category = 'fuel';
        break;
      case 'parking':
        category = 'parking';
        break;
      case 'proxy':
        category = 'agency_drive';
        break;
      case 'purchase':
        category = 'supplies';
        memoPrefix = '[물품구입] ';
        break;
      case 'custom':
        category = 'custom';
        break;
    }

    // 결제 수단 매핑
    let payMethod: NonNullable<VehicleExpense['payMethod']> = 'cash';
    if (expense.payMethod === 'company_card') {
      payMethod = 'company_card';
    } else if (expense.payMethod === 'personal_card') {
      payMethod = 'personal_card';
    } else if (expense.payMethod === 'cash_personal') {
      payMethod = 'cash';
      memoPrefix += '[개인현금] ';
    } else if (expense.payMethod === 'cash_company') {
      payMethod = 'cash';
      memoPrefix += '[법인현금] ';
    }

    const memoContent = `${memoPrefix}${expense.memo || ''} (업무일지 연동: ${logTitle})`;

    dbData.expenses.unshift({
      id: `ve-wl-${logId}-${expense.id}`,
      vehicleId: expense.vehicleId,
      date: logDate,
      category: category,
      categoryCustom: expense.categoryCustom,
      amount: Number(expense.amount) || 0,
      memo: memoContent.trim(),
      payMethod: payMethod,
      // [수정] 업무일지 지출 쪽에서 이미 Storage에 업로드된 영수증 URL을 그대로 같이 넘겨서,
      // 연동된 차량 비용 화면에서도 같은 영수증 사진을 볼 수 있게 한다.
      receiptImage: expense.receiptImage,
      createdAt: new Date().toISOString()
    });
  });
}

// [추가] 애플 캘린더(아이폰/아이패드/맥) 연동용 API.
// 1) POST로 이 사용자(회사 스코프)의 구독용 토큰 URL을 발급/조회한다 (로그인 세션 필요).
// 2) GET .ics 피드는 애플 캘린더 앱이 로그인 없이 주기적으로 그냥 URL만 불러가므로,
//    x-user-id 헤더 대신 URL에 담긴 토큰으로 스코프를 식별한다.
app.post('/api/worklogs/calendar-token', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const user = userId ? users.find(u => u.id === userId) : undefined;
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });

  if (!user.calendarFeedToken) {
    user.calendarFeedToken = crypto.randomBytes(24).toString('hex');
    await addUser(user);
  }

  const host = req.get('host');
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  res.json({
    token: user.calendarFeedToken,
    feedUrl: `${protocol}://${host}/api/worklogs/calendar.ics?token=${user.calendarFeedToken}`,
    // webcal:// 스킴은 아이폰/아이패드/맥에서 링크를 누르면 캘린더 앱이 바로 "구독 추가"
    // 화면을 띄워준다 (https 링크는 그냥 브라우저에서 텍스트로 열려버림).
    webcalUrl: `webcal://${host}/api/worklogs/calendar.ics?token=${user.calendarFeedToken}`
  });
});

// [추가] 실제 .ics(iCalendar) 피드. 업무일지(일일/주간)에 적힌 항목들을 일정으로 변환한다.
// 캘린더 탭에서 보여주는 것과 같은 항목(회사 전체 업무일지)을 그대로 담아서, 앱 화면과
// 애플 캘린더에 보이는 내용이 서로 다르지 않게 한다.
function icsEscape(text: string): string {
  return (text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
function icsDateTime(dateStr: string, timeStr?: string): string {
  // timeStr("HH:MM")가 있으면 그 시각으로, 없으면 해당 날짜 자정(00:00)으로 표기한다.
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}${pad(m)}${pad(d)}T${pad(hh || 0)}${pad(mm || 0)}00`;
}

app.get('/api/worklogs/calendar.ics', (req, res) => {
  const token = req.query.token as string;
  const user = token ? users.find(u => u.calendarFeedToken === token) : undefined;
  if (!user) return res.status(404).send('유효하지 않은 캘린더 구독 링크입니다.');

  const scopeId = scopeIdForUser(user);
  const dbData = db[scopeId] || { dailyLogs: [], weeklyLogs: [] };

  const events: string[] = [];
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  for (const l of dbData.dailyLogs || []) {
    const entries = (l.taskEntriesToday && l.taskEntriesToday.length > 0)
      ? l.taskEntriesToday
      : (l.tasksToday && l.tasksToday.trim() ? [{ id: 'legacy', content: l.tasksToday }] : []);
    for (const t of entries) {
      if (!t.content || !t.content.trim()) continue;
      const start = icsDateTime(l.date, t.startTime);
      const end = icsDateTime(l.date, t.endTime || t.startTime);
      events.push([
        'BEGIN:VEVENT',
        `UID:daily-${l.id}-${t.id}@bizcard-pro`,
        `DTSTAMP:${now}`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${icsEscape(`[업무일지] ${l.author || ''} ${t.content}`.trim())}`,
        `DESCRIPTION:${icsEscape(t.content)}`,
        'END:VEVENT'
      ].join('\r\n'));
    }
  }

  const dayKeys: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  for (const wl of dbData.weeklyLogs || []) {
    if (!wl.startDate) continue;
    const start = new Date(wl.startDate);
    dayKeys.forEach((key, offset) => {
      const d = new Date(start);
      d.setDate(d.getDate() + offset);
      const dateStr = d.toISOString().split('T')[0];

      const structured = wl.achievementEntriesByDay?.[key];
      const entries = (structured && structured.length > 0)
        ? structured
        : (wl.achievementsByDay?.[key]?.trim() ? [{ id: 'legacy', content: wl.achievementsByDay![key]! }] : []);

      for (const t of entries) {
        if (!t.content || !t.content.trim()) return;
        const s = icsDateTime(dateStr, t.startTime);
        const e = icsDateTime(dateStr, t.endTime || t.startTime);
        events.push([
          'BEGIN:VEVENT',
          `UID:weekly-${wl.id}-${key}-${t.id}@bizcard-pro`,
          `DTSTAMP:${now}`,
          `DTSTART:${s}`,
          `DTEND:${e}`,
          `SUMMARY:${icsEscape(`[업무일지] ${wl.author || ''} ${t.content}`.trim())}`,
          `DESCRIPTION:${icsEscape(t.content)}`,
          'END:VEVENT'
        ].join('\r\n'));
      }
    });
  }

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BizCard Pro AI//WorkLogs Calendar//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:BizCard 업무일지',
    'X-WR-TIMEZONE:Asia/Seoul',
    ...events,
    'END:VCALENDAR'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="bizcard-pro-worklogs.ics"');
  res.send(ics);
});

// ------------------------------------------------------------------
// 📅 CalDAV 양방향 캘린더 연동 (아이폰/아이패드/맥 캘린더 앱에서 직접 수정 가능)
// [추가] 위의 .ics 구독 피드는 앱→캘린더 한쪽 방향만 됐다. 캘린더 앱에서 직접 만들거나
// 고친 일정이 앱으로 돌아오려면 CalDAV(WebDAV 기반 캘린더 프로토콜)를 구현해야 한다.
//
// 주의: 이 구현은 최소 기능만 담은 1차 버전이다. 이 환경에서는 실제 아이폰/맥 캘린더
// 앱으로 직접 연결해서 검증할 방법이 없어서, 배포 후 실제 기기로 계정 추가부터
// 해봐야 확실히 동작을 확인할 수 있다 — 애플 캘린더 클라이언트가 세부 사항에
// 유난히 까다로운 편이라, 연결 자체는 되는데 특정 동작(예: 반복 일정, 즉시 동기화
// 타이밍)에서 조정이 더 필요할 수 있다.
//
// 사용법(아이폰): 설정 > 캘린더 > 계정 > 계정 추가 > 기타 > CalDAV 계정 추가
//   서버: app.bizcardai.kr  사용자 이름: (로그인 이메일)  암호: (로그인 비밀번호)
// ------------------------------------------------------------------

// CalDAV는 세션 대신 매 요청마다 Basic 인증(이메일+비밀번호)을 사용한다.
function parseBasicAuth(req: express.Request): { email: string; password: string } | null {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { email: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function requireCalDavAuth(req: express.Request, res: express.Response): RegisteredUser | null {
  const creds = parseBasicAuth(req);
  const user = creds ? users.find(u => u.email.toLowerCase() === creds.email.toLowerCase()) : undefined;
  if (!user || !creds || !verifyPassword(creds.password, user.password)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="BizCard Calendar"');
    res.status(401).send('Unauthorized');
    return null;
  }
  return user;
}

const caldavRouter = express.Router();
caldavRouter.use(express.text({ type: () => true, limit: '5mb' })); // XML/ICS 원문을 문자열 그대로 받는다

// [추가] 실제 캘린더 앱(아이폰/맥)은 CORS 대상이 아니라 이 헤더가 필요 없지만, 브라우저
// 기반 진단/테스트 도구(예: 문제 확인용 테스트 페이지)에서 이 API를 두드려볼 수 있도록
// 허용해둔다. Basic Auth로 어차피 계정별 접근이 걸려있어서 위험이 낮다.
caldavRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Depth, If-Match, If-None-Match');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, DAV');
  next();
});

caldavRouter.use((req, res, next) => {
  // OPTIONS는 클라이언트가 로그인 화면 뜨기 전에 서버 능력을 먼저 확인하려고 인증 없이
  // 보내는 경우가 있어서, 인증 요구 없이 바로 답해준다.
  if (req.method === 'OPTIONS') {
    res.setHeader('DAV', '1, 2, 3, calendar-access, calendar-schedule');
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR');
    return res.status(200).end();
  }
  next();
});

function icsUidEscape(s: string) { return s.replace(/[^a-zA-Z0-9._-]/g, '_'); }

// scopeId 안의 모든 daily/weekly 업무 항목을 CalDAV용 평평한 이벤트 목록으로 변환
function collectCaldavEvents(scopeId: string) {
  const dbData = db[scopeId];
  if (!dbData) return [] as { uid: string; summary: string; description: string; dtstart: string; dtend: string; etag: string }[];
  const out: { uid: string; summary: string; description: string; dtstart: string; dtend: string; etag: string }[] = [];

  for (const l of dbData.dailyLogs || []) {
    const entries = (l.taskEntriesToday && l.taskEntriesToday.length > 0) ? l.taskEntriesToday : [];
    for (const t of entries) {
      if (!t.content || !t.content.trim()) continue;
      // [수정] 구분자로 하이픈(-)을 쓰면, 캘린더 앱이 직접 만든 일정의 UID(보통 UUID라서
      // 자체에 하이픈이 많다, 예: "550E8400-E29B-...")가 taskId로 들어올 때 어디까지가
      // logId이고 어디부터 taskId인지 구분이 안 되는 문제가 있었다. 서버가 만드는 id에도
      // 하이픈이 들어가므로, 절대 겹치지 않을 이중 밑줄(__)을 구분자로 쓴다.
      const uid = `daily__${l.id}__${t.id}`;
      out.push({
        uid,
        summary: `[업무일지] ${l.author || ''} ${t.content}`.trim(),
        description: t.content,
        dtstart: icsDateTime(l.date, t.startTime),
        dtend: icsDateTime(l.date, t.endTime || t.startTime),
        etag: `"${icsUidEscape(uid)}-${(t.content || '').length}-${t.startTime || ''}-${t.endTime || ''}"`
      });
    }
  }

  const dayKeys: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  for (const wl of dbData.weeklyLogs || []) {
    if (!wl.startDate) continue;
    const start = new Date(wl.startDate);
    dayKeys.forEach((key, offset) => {
      const d = new Date(start);
      d.setDate(d.getDate() + offset);
      const dateStr = d.toISOString().split('T')[0];
      const entries = wl.achievementEntriesByDay?.[key] || [];
      for (const t of entries) {
        if (!t.content || !t.content.trim()) continue;
        const uid = `weekly__${wl.id}__${key}__${t.id}`;
        out.push({
          uid,
          summary: `[업무일지] ${wl.author || ''} ${t.content}`.trim(),
          description: t.content,
          dtstart: icsDateTime(dateStr, t.startTime),
          dtend: icsDateTime(dateStr, t.endTime || t.startTime),
          etag: `"${icsUidEscape(uid)}-${(t.content || '').length}-${t.startTime || ''}-${t.endTime || ''}"`
        });
      }
    });
  }

  return out;
}

function buildVEventIcs(ev: { uid: string; summary: string; description: string; dtstart: string; dtend: string }): string {
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BizCard Pro AI//CalDAV//KO',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${ev.uid}@bizcard-pro`,
    `DTSTAMP:${now}`,
    `DTSTART:${ev.dtstart}`,
    `DTEND:${ev.dtend}`,
    `SUMMARY:${icsEscape(ev.summary)}`,
    `DESCRIPTION:${icsEscape(ev.description)}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

// 아주 단순한 ICS VEVENT 파서 (캘린더 앱이 PUT으로 보내는 내용만 읽으면 되므로 SUMMARY/
// DESCRIPTION/DTSTART/DTEND/UID 정도만 뽑아낸다. 반복 일정(RRULE) 등은 다루지 않는다.)
function parseVEvent(ics: string): { uid?: string; summary?: string; description?: string; dtstart?: string; dtend?: string } {
  const unescape = (v: string) => v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
  const lines = ics.split(/\r\n|\n|\r/);
  const result: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const rawKey = line.slice(0, idx);
    const key = rawKey.split(';')[0].toUpperCase();
    const value = line.slice(idx + 1);
    if (key === 'UID') result.uid = value.trim();
    else if (key === 'SUMMARY') result.summary = unescape(value);
    else if (key === 'DESCRIPTION') result.description = unescape(value);
    else if (key === 'DTSTART') result.dtstart = value.trim();
    else if (key === 'DTEND') result.dtend = value.trim();
  }
  return result;
}

// "20260810T093000" 또는 "20260810T093000Z" 형태를 { date: 'YYYY-MM-DD', time: 'HH:MM' }로 변환
function parseIcsDateTime(v?: string): { date: string; time?: string } | null {
  if (!v) return null;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return { date: `${y}-${mo}-${d}`, time: hh ? `${hh}:${mm}` : undefined };
}

caldavRouter.use(async (req, res, next) => {
  const user = requireCalDavAuth(req, res);
  if (!user) return; // requireCalDavAuth가 이미 401 응답을 보냄
  req.caldavUser = user;
  // [수정] 목록 조회(PROPFIND/REPORT)에서는 이 로딩을 빼먹어서, 아직 메모리에 캐시되지
  // 않은 스코프의 경우 db[scopeId]가 비어있어 빈 캘린더처럼 보이는 문제가 있었다.
  // 모든 caldav 요청 공통으로 여기서 한 번에 로딩을 보장한다.
  await loadScopeFromSupabase(scopeIdForUser(user));
  next();
});

// well-known 디스커버리: 캘린더 앱이 서버 주소만 알아도 여기로 먼저 물어본다.
// [수정] 예전엔 GET만 처리했는데, 아이폰이 PROPFIND로 바로 이 경로를 두드리는 경우가
// 있어서 모든 메서드에 응답하도록 넓혔다.
app.all('/.well-known/caldav', (req, res) => {
  res.redirect(301, '/caldav/');
});

// [추가] 아이폰/맥이 "서버 주소"란에 경로 없이 도메인만 입력하면, well-known을 거치지
// 않고 곧바로 루트(/)에 PROPFIND나 OPTIONS를 보내 캘린더(WebDAV) 지원 여부를 확인하는
// 경우가 있다. 루트는 원래 웹앱 화면(SPA)이 GET으로 응답하는 자리라 이 요청들에 응답할
// 게 없어서, 클라이언트가 "SSL로 연결할 수 없음" 같은 애매한 에러를 띄우는 원인이 됐다.
// GET/HEAD(=웹앱 화면 요청)는 그대로 SPA로 흘려보내고, PROPFIND/OPTIONS/REPORT만
// 여기서 가로채 "캘린더 있는 위치는 /caldav/ 다"라고 안내해서 자동 탐색이 이어지게 한다.
app.all('/', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.method === 'OPTIONS') {
    res.setHeader('DAV', '1, 2, 3, calendar-access, calendar-schedule');
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
    return res.status(200).end();
  }
  if (req.method === 'PROPFIND') {
    return res.redirect(301, '/caldav/');
  }
  next();
});

// 루트: 로그인한 사용자의 principal 위치를 알려준다
caldavRouter.all('/', (req, res) => {
  if (req.method !== 'PROPFIND') return res.status(405).end();
  const user = req.caldavUser as RegisteredUser;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/caldav/</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal><D:href>/caldav/principals/${user.id}/</D:href></D:current-user-principal>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
  res.status(207).setHeader('Content-Type', 'application/xml; charset=utf-8').send(xml);
});

// principal: 이 사용자의 캘린더 홈 위치를 알려준다
caldavRouter.all('/principals/:userId/', (req, res) => {
  if (req.method !== 'PROPFIND') return res.status(405).end();
  const user = req.caldavUser as RegisteredUser;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/caldav/principals/${user.id}/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${user.name}</D:displayname>
        <C:calendar-home-set><D:href>/caldav/calendars/${user.id}/</D:href></C:calendar-home-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
  res.status(207).setHeader('Content-Type', 'application/xml; charset=utf-8').send(xml);
});

// 캘린더 홈: 그 안에 캘린더가 하나("worklogs") 있다고 알려준다
caldavRouter.all('/calendars/:userId/', (req, res) => {
  if (req.method !== 'PROPFIND') return res.status(405).end();
  const user = req.caldavUser as RegisteredUser;
  const depth = req.headers['depth'] || '0';
  let responses = `
  <D:response>
    <D:href>/caldav/calendars/${user.id}/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
  if (depth !== '0') {
    responses += `
  <D:response>
    <D:href>/caldav/calendars/${user.id}/worklogs/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>BizCard 업무일지</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
  }
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}
</D:multistatus>`;
  res.status(207).setHeader('Content-Type', 'application/xml; charset=utf-8').send(xml);
});

// 실제 캘린더 컬렉션: depth 0이면 컬렉션 속성만, depth 1이면 안에 든 이벤트 목록까지
caldavRouter.all('/calendars/:userId/worklogs/', (req, res) => {
  const user = req.caldavUser as RegisteredUser;
  const scopeId = scopeIdForUser(user);

  if (req.method === 'MKCALENDAR') {
    // 이미 가상으로 존재하는 컬렉션이므로 그냥 성공 처리
    return res.status(201).end();
  }
  if (req.method !== 'PROPFIND' && req.method !== 'REPORT') return res.status(405).end();

  const events = collectCaldavEvents(scopeId);
  const ctag = `"${events.length}-${events.map(e => e.etag).join('').length}"`;

  if (req.method === 'PROPFIND') {
    const depth = req.headers['depth'] || '0';
    let responses = `
  <D:response>
    <D:href>/caldav/calendars/${user.id}/worklogs/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>BizCard 업무일지</D:displayname>
        <CS:getctag xmlns:CS="http://calendarserver.org/ns/">${ctag}</CS:getctag>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
    if (depth !== '0') {
      for (const ev of events) {
        responses += `
  <D:response>
    <D:href>/caldav/calendars/${user.id}/worklogs/${ev.uid}.ics</D:href>
    <D:propstat>
      <D:prop><D:getetag>${ev.etag}</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
      }
    }
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}
</D:multistatus>`;
    return res.status(207).setHeader('Content-Type', 'application/xml; charset=utf-8').send(xml);
  }

  // REPORT: calendar-multiget(특정 href들만) 또는 sync-collection(전체 동기화)를 다룬다.
  // [참고] sync-collection의 "삭제된 항목" 통지는 별도 이력을 추적하지 않아 생략했다 —
  // 캘린더 앱이 매번 전체 목록을 다시 훑으므로 기능은 되지만, 대량 데이터에서는
  // 이론적으로 비효율적일 수 있다(1차 버전 한계).
  const body = (req.body as string) || '';
  const isMultiget = body.includes('calendar-multiget');
  let targetUids: string[] | null = null;
  if (isMultiget) {
    const hrefMatches = [...body.matchAll(/<[^:>]*:?href>([^<]+)<\/[^:>]*:?href>/g)].map(m => m[1]);
    targetUids = hrefMatches.map(h => h.split('/').pop()?.replace(/\.ics$/, '') || '');
  }

  const targetEvents = targetUids ? events.filter(e => targetUids!.includes(e.uid)) : events;
  let responses = '';
  for (const ev of targetEvents) {
    const calData = buildVEventIcs(ev);
    responses += `
  <D:response>
    <D:href>/caldav/calendars/${user.id}/worklogs/${ev.uid}.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${ev.etag}</D:getetag>
        <C:calendar-data><![CDATA[${calData}]]></C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
  }
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}
  <D:sync-token>http://bizcard-pro/sync/${ctag}</D:sync-token>
</D:multistatus>`;
  res.status(207).setHeader('Content-Type', 'application/xml; charset=utf-8').send(xml);
});

// 이벤트 하나: GET(조회) / PUT(생성·수정) / DELETE(삭제)
caldavRouter.all('/calendars/:userId/worklogs/:uidIcs', async (req, res) => {
  const user = req.caldavUser as RegisteredUser;
  const scopeId = scopeIdForUser(user);
  await loadScopeFromSupabase(scopeId);
  const dbData = db[scopeId];
  const uid = req.params.uidIcs.replace(/\.ics$/, '');

  if (req.method === 'GET' || req.method === 'HEAD') {
    const events = collectCaldavEvents(scopeId);
    const ev = events.find(e => e.uid === uid);
    if (!ev) return res.status(404).end();
    res.setHeader('ETag', ev.etag);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    return res.send(req.method === 'HEAD' ? '' : buildVEventIcs(ev));
  }

  if (req.method === 'DELETE') {
    const dailyMatch = uid.match(/^daily__(.+)__([^_]+)$/);
    const weeklyMatch = uid.match(/^weekly__(.+)__(mon|tue|wed|thu|fri|sat|sun)__([^_]+)$/);
    let removed = false;

    if (dailyMatch) {
      const [, logId, taskId] = dailyMatch;
      const log = (dbData.dailyLogs || []).find(l => l.id === logId);
      if (log?.taskEntriesToday) {
        const before = log.taskEntriesToday.length;
        log.taskEntriesToday = log.taskEntriesToday.filter(t => t.id !== taskId);
        removed = log.taskEntriesToday.length < before;
        log.tasksToday = log.taskEntriesToday.map(t => t.content).join('\n');
        if (log.taskEntriesToday.length === 0 && !log.tasksTomorrow && !log.issues) {
          dbData.dailyLogs = (dbData.dailyLogs || []).filter(l => l.id !== logId);
          await deleteScopedDoc(scopeId, 'dailyLogs', logId);
        } else {
          await setScopedDoc(scopeId, 'dailyLogs', log);
        }
      }
    } else if (weeklyMatch) {
      const [, wlId, dayKey, taskId] = weeklyMatch;
      const wl = (dbData.weeklyLogs || []).find(w => w.id === wlId);
      const dayEntries = wl?.achievementEntriesByDay?.[dayKey as keyof typeof wl.achievementEntriesByDay];
      if (wl && dayEntries) {
        const before = dayEntries.length;
        wl.achievementEntriesByDay![dayKey as 'mon'] = dayEntries.filter(t => t.id !== taskId);
        removed = wl.achievementEntriesByDay![dayKey as 'mon']!.length < before;
        if (wl.achievementsByDay) {
          wl.achievementsByDay[dayKey as 'mon'] = wl.achievementEntriesByDay![dayKey as 'mon']!.map(t => t.content).join('\n');
        }
        await setScopedDoc(scopeId, 'weeklyLogs', wl);
      }
    }

    if (!removed) return res.status(404).end();
    return res.status(204).end();
  }

  if (req.method === 'PUT') {
    const parsed = parseVEvent((req.body as string) || '');
    const start = parseIcsDateTime(parsed.dtstart);
    const end = parseIcsDateTime(parsed.dtend);
    const content = parsed.summary || parsed.description || '(제목 없음)';

    const dailyMatch = uid.match(/^daily__(.+)__([^_]+)$/);
    const weeklyMatch = uid.match(/^weekly__(.+)__(mon|tue|wed|thu|fri|sat|sun)__([^_]+)$/);

    if (dailyMatch) {
      // 기존 daily 항목 수정
      const [, logId, taskId] = dailyMatch;
      const log = (dbData.dailyLogs || []).find(l => l.id === logId);
      if (log?.taskEntriesToday) {
        const task = log.taskEntriesToday.find(t => t.id === taskId);
        if (task) {
          task.content = content;
          if (start?.time) task.startTime = start.time;
          if (end?.time) task.endTime = end.time;
          log.tasksToday = log.taskEntriesToday.map(t => t.content).join('\n');
          await setScopedDoc(scopeId, 'dailyLogs', log);
          return res.status(204).end();
        }
      }
      // 못 찾으면 새로 만든다 (아래 공통 생성 로직으로 진행)
    } else if (weeklyMatch) {
      const [, wlId, dayKey, taskId] = weeklyMatch;
      const wl = (dbData.weeklyLogs || []).find(w => w.id === wlId);
      const dayEntries = wl?.achievementEntriesByDay?.[dayKey as keyof typeof wl.achievementEntriesByDay];
      const task = dayEntries?.find(t => t.id === taskId);
      if (wl && task) {
        task.content = content;
        if (start?.time) task.startTime = start.time;
        if (end?.time) task.endTime = end.time;
        if (wl.achievementsByDay) {
          wl.achievementsByDay[dayKey as 'mon'] = (dayEntries || []).map(t => t.content).join('\n');
        }
        await setScopedDoc(scopeId, 'weeklyLogs', wl);
        return res.status(204).end();
      }
    }

    // 새 이벤트: 캘린더 앱에서 직접 새로 만든 일정 -> 그 날짜의 새 일일 업무일지로 등록
    if (!start) return res.status(400).send('DTSTART이 없어 날짜를 알 수 없습니다.');
    // [수정] 여기서 만드는 로그 id에 "daily-" 접두사를 붙였었는데, UID를 만들 때
    // (collectCaldavEvents, `daily-${l.id}-${t.id}`) 이미 "daily-"를 앞에 붙이고 있어서
    // 최종 UID가 "daily-daily-..."처럼 접두사가 두 번 겹치는 버그가 있었다. 로그 id
    // 자체에는 접두사를 넣지 않는다.
    const newLogId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newTaskId = uid; // 캘린더 앱이 준 UID를 그대로 항목 id로 써서, 다음 수정/삭제 때 다시 찾을 수 있게 한다
    const newTask: WorkLogDayEntry = { id: newTaskId, content, startTime: start.time, endTime: end?.time || start.time };
    const newLog: DailyWorkLog = {
      id: newLogId,
      date: start.date,
      title: 'Apple 캘린더에서 추가한 일정',
      author: user.name,
      tasksToday: content,
      taskEntriesToday: [newTask],
      tasksTomorrow: '',
      createdAt: new Date().toISOString()
    };
    dbData.dailyLogs = [newLog, ...(dbData.dailyLogs || [])];
    await setScopedDoc(scopeId, 'dailyLogs', newLog);
    // 캘린더 앱이 기대하는 실제 href로 다시 찾아갈 수 있도록, 새로 부여한 uid를 알려준다.
    // (uid가 daily-{newLogId}-{newTaskId} 형식이 아니라 클라이언트가 준 값 그대로이므로,
    // GET/DELETE 시 daily-... 정규식에 안 걸려서 "새 이벤트로 다시 취급"될 수 있다 —
    // 아래에서 taskId에 uid를 그대로 썼기 때문에 daily-{newLogId}-{uid} 패턴으로는 못 찾고,
    // 대신 전체 dailyLogs를 훑어 taskId로 직접 매칭하는 폴백을 GET/DELETE 쪽에도 필요하면
    // 추가해야 한다. 1차 버전에서는 uid가 daily-... 형식이 아닌 경우, 다음 REPORT/PROPFIND
    // 때 collectCaldavEvents가 만들어내는 실제 uid(`daily-${newLogId}-${newTaskId}`)로
    // 캘린더 앱이 자연스럽게 갈아탄다.
    return res.status(201).end();
  }

  return res.status(405).end();
});

app.use('/caldav', caldavRouter);

// 일일 업무일지 CRUD
app.get('/api/worklogs/daily', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);

  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const dbData = getScopedData(req);
  res.json(dbData.dailyLogs || []);
});

app.post('/api/worklogs/daily', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const log: DailyWorkLog = req.body;
  if (!log.id) log.id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!log.createdAt) log.createdAt = new Date().toISOString();
  if (!log.projectIds) log.projectIds = [];
  if (!log.contactIds) log.contactIds = [];

  // [수정] 지출 영수증 사진들을 Storage에 업로드 후 URL로 교체 (차량비용 연동 동기화보다 먼저 해야
  // 동기화되는 차량 지출 항목에도 URL이 반영된다)
  log.expenses = await persistReceiptImagesInArray(scopeId, log.expenses, `worklog-daily-${log.id}`);
  
  // 비용 항목 연동 동기화
  syncWorkLogExpenses(dbData, log.id, log.date, log.title, log.expenses);

  dbData.dailyLogs = dbData.dailyLogs || [];
  dbData.dailyLogs.unshift(log);
  // [수정] 지출 영수증 스캔본이 포함된 업무일지 저장이 DB에 실제로 실패했는데도 조용히
  // "성공"으로 응답하던 문제를 고쳤다. 실패하면 방금 추가한 것을 되돌리고 알린다.
  const [savedDailyLog] = await Promise.all([
    setScopedDoc(scopeId, 'dailyLogs', log),
    replaceScopedCollection(scopeId, 'expenses', dbData.expenses)
  ]);
  if (!savedDailyLog) {
    dbData.dailyLogs = dbData.dailyLogs.filter((l: DailyWorkLog) => l.id !== log.id);
    return res.status(500).json({ error: '업무일지를 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  // [추가] 이 일지에 새로 초대된 동료가 있으면 알림 메일 발송 (신규 등록이라 이전 목록은 없음)
  const inviterUser = users.find(u => u.id === (req.headers['x-user-id'] as string));
  notifyNewWorkLogInvites({
    inviterId: inviterUser?.id || '',
    inviterName: inviterUser?.name || log.author || '동료',
    title: log.title,
    date: log.date,
    beforeIds: [],
    afterIds: log.invitedUserIds
  });
  res.status(201).json(log);
});

app.put('/api/worklogs/daily/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.dailyLogs = dbData.dailyLogs || [];
  const idx = dbData.dailyLogs.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Daily log not found' });
  
  const original = dbData.dailyLogs[idx];
  const updated = { ...original, ...req.body };
  updated.expenses = await persistReceiptImagesInArray(scopeId, updated.expenses, `worklog-daily-${req.params.id}`);
  dbData.dailyLogs[idx] = updated;

  // 비용 항목 연동 동기화
  syncWorkLogExpenses(dbData, req.params.id, updated.date, updated.title, updated.expenses);

  // [수정] 위 등록(POST)과 동일한 이유로, 저장 실패를 조용히 넘기지 않고 되돌린 뒤 알린다.
  const [savedDailyLogUpdate] = await Promise.all([
    setScopedDoc(scopeId, 'dailyLogs', updated),
    replaceScopedCollection(scopeId, 'expenses', dbData.expenses)
  ]);
  if (!savedDailyLogUpdate) {
    dbData.dailyLogs[idx] = original;
    return res.status(500).json({ error: '업무일지 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  // [추가] 이번 수정으로 새로 초대된 동료(원래 목록엔 없었는데 새로 추가된 사람)에게만 알림 메일 발송
  const inviterUser = users.find(u => u.id === (req.headers['x-user-id'] as string));
  notifyNewWorkLogInvites({
    inviterId: inviterUser?.id || '',
    inviterName: inviterUser?.name || updated.author || '동료',
    title: updated.title,
    date: updated.date,
    beforeIds: original.invitedUserIds,
    afterIds: updated.invitedUserIds
  });
  res.json(dbData.dailyLogs[idx]);
});

app.delete('/api/worklogs/daily/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.dailyLogs = dbData.dailyLogs || [];
  dbData.dailyLogs = dbData.dailyLogs.filter(l => l.id !== req.params.id);
  
  // 해당 업무일지에 매핑되어 있던 비용 내역도 제거
  dbData.expenses = dbData.expenses || [];
  dbData.expenses = dbData.expenses.filter((e) => !e.id.startsWith(`ve-wl-${req.params.id}-`));

  await Promise.all([
    deleteScopedDoc(scopeId, 'dailyLogs', req.params.id),
    replaceScopedCollection(scopeId, 'expenses', dbData.expenses)
  ]);
  res.json({ success: true });
});

// 주간 업무일지 CRUD
app.get('/api/worklogs/weekly', (req, res) => {
  const requesterId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === requesterId);

  if (!requester) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const dbData = getScopedData(req);
  res.json(dbData.weeklyLogs || []);
});

app.post('/api/worklogs/weekly', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const log: WeeklyWorkLog = req.body;
  if (!log.id) log.id = `wl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!log.createdAt) log.createdAt = new Date().toISOString();
  if (!log.projectIds) log.projectIds = [];
  if (!log.contactIds) log.contactIds = [];

  // [수정] 지출 영수증 사진들을 Storage에 업로드 후 URL로 교체
  log.expenses = await persistReceiptImagesInArray(scopeId, log.expenses, `worklog-weekly-${log.id}`);

  // 비용 항목 연동 동기화 (주간은 시작일을 지출일자로 연동)
  syncWorkLogExpenses(dbData, log.id, log.startDate, log.title, log.expenses);

  dbData.weeklyLogs = dbData.weeklyLogs || [];
  dbData.weeklyLogs.unshift(log);
  // [수정] 위 일일 업무일지와 동일한 이유로, 저장 실패를 조용히 넘기지 않고 되돌린 뒤 알린다.
  const [savedWeeklyLog] = await Promise.all([
    setScopedDoc(scopeId, 'weeklyLogs', log),
    replaceScopedCollection(scopeId, 'expenses', dbData.expenses)
  ]);
  if (!savedWeeklyLog) {
    dbData.weeklyLogs = dbData.weeklyLogs.filter((l: WeeklyWorkLog) => l.id !== log.id);
    return res.status(500).json({ error: '주간 업무일지를 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  // [추가] 이 일지에 새로 초대된 동료가 있으면 알림 메일 발송 (신규 등록이라 이전 목록은 없음)
  const inviterUser = users.find(u => u.id === (req.headers['x-user-id'] as string));
  notifyNewWorkLogInvites({
    inviterId: inviterUser?.id || '',
    inviterName: inviterUser?.name || log.author || '동료',
    title: log.title,
    date: log.startDate,
    beforeIds: [],
    afterIds: log.invitedUserIds
  });
  res.status(201).json(log);
});

app.put('/api/worklogs/weekly/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.weeklyLogs = dbData.weeklyLogs || [];
  const idx = dbData.weeklyLogs.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Weekly log not found' });
  
  const original = dbData.weeklyLogs[idx];
  const updated = { ...original, ...req.body };
  updated.expenses = await persistReceiptImagesInArray(scopeId, updated.expenses, `worklog-weekly-${req.params.id}`);
  dbData.weeklyLogs[idx] = updated;

  // 비용 항목 연동 동기화 (주간은 시작일을 지출일자로 연동)
  syncWorkLogExpenses(dbData, req.params.id, updated.startDate, updated.title, updated.expenses);

  const [savedWeeklyLogUpdate] = await Promise.all([
    setScopedDoc(scopeId, 'weeklyLogs', updated),
    replaceScopedCollection(scopeId, 'expenses', dbData.expenses)
  ]);
  if (!savedWeeklyLogUpdate) {
    dbData.weeklyLogs[idx] = original;
    return res.status(500).json({ error: '주간 업무일지 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  // [추가] 이번 수정으로 새로 초대된 동료(원래 목록엔 없었는데 새로 추가된 사람)에게만 알림 메일 발송
  const inviterUser = users.find(u => u.id === (req.headers['x-user-id'] as string));
  notifyNewWorkLogInvites({
    inviterId: inviterUser?.id || '',
    inviterName: inviterUser?.name || updated.author || '동료',
    title: updated.title,
    date: updated.startDate,
    beforeIds: original.invitedUserIds,
    afterIds: updated.invitedUserIds
  });
  res.json(dbData.weeklyLogs[idx]);
});

app.delete('/api/worklogs/weekly/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.weeklyLogs = dbData.weeklyLogs || [];
  dbData.weeklyLogs = dbData.weeklyLogs.filter(l => l.id !== req.params.id);
  
  // 해당 업무일지에 매핑되어 있던 비용 내역도 제거
  dbData.expenses = dbData.expenses || [];
  dbData.expenses = dbData.expenses.filter((e) => !e.id.startsWith(`ve-wl-${req.params.id}-`));

  await Promise.all([
    deleteScopedDoc(scopeId, 'weeklyLogs', req.params.id),
    replaceScopedCollection(scopeId, 'expenses', dbData.expenses)
  ]);
  res.json({ success: true });
});

// ------------------------------------------------------------------
// 📧 이메일 발송 (Brevo HTTPS API 방식)
// [수정] Render 무료 요금제는 아웃바운드 SMTP 포트(25/465/587) 자체를 차단한다. 그래서
// Daum이든 Gmail이든 "SMTP 프로토콜"로 보내는 방식은 서버가 유료로 전환되지 않는 한 절대
// 작동할 수 없다. 대신 일반 웹 요청과 똑같은 HTTPS(포트 443, 절대 안 막힘)로 메일을
// 보내주는 Brevo의 API를 사용한다. 여기서는 nodemailer/SMTP를 아예 쓰지 않는다.
// 환경변수: BREVO_API_KEY, SMTP_FROM_EMAIL(Brevo에서 인증 완료한 발신 이메일), SMTP_FROM_NAME, APP_BASE_URL
// ------------------------------------------------------------------
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'BizCard 전자결재';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.bizcardai.kr';

const isMailerConfigured = Boolean(BREVO_API_KEY && SMTP_FROM_EMAIL);
if (!isMailerConfigured) {
  console.warn('[mailer] BREVO_API_KEY 또는 SMTP_FROM_EMAIL 환경변수가 설정되지 않아 이메일 발송이 비활성화됩니다.');
}

// 모든 이메일 발송이 공통으로 거쳐가는 단일 함수. 첨부파일(영수증 압축파일 등)도 지원한다.
async function sendEmail(opts: {
  to: string; toName?: string; subject: string; html: string;
  attachments?: { filename: string; content: Buffer }[];
}): Promise<void> {
  if (!isMailerConfigured) {
    console.warn(`[mailer] 미설정 상태라 ${opts.to}에게 메일을 보내지 못했습니다.`);
    return;
  }
  const payload: Record<string, unknown> = {
    sender: { name: SMTP_FROM_NAME, email: SMTP_FROM_EMAIL },
    to: [{ email: opts.to, name: opts.toName || opts.to }],
    subject: opts.subject,
    htmlContent: opts.html
  };
  if (opts.attachments && opts.attachments.length > 0) {
    payload.attachment = opts.attachments.map((a) => ({
      name: a.filename,
      content: a.content.toString('base64')
    }));
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY as string,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Brevo 메일 발송 실패 (${res.status}): ${errText}`);
  }
}

async function sendApprovalRequestEmail(opts: {
  toEmail: string; toName: string; approverRole: string;
  docTypeLabel: string; draftNumber: string; authorName: string;
}) {
  if (!isMailerConfigured) {
    console.warn(`[mailer] 미설정 상태라 ${opts.toEmail}에게 결재 요청 이메일을 보내지 못했습니다.`);
    return;
  }
  try {
    await sendEmail({
      to: opts.toEmail,
      toName: opts.toName,
      subject: `[결재 요청] ${opts.docTypeLabel} - ${opts.authorName}님이 상신한 문서 (기안번호: ${opts.draftNumber})`,
      html: `
        <div style="font-family: 'Malgun Gothic', sans-serif; padding: 24px; color:#111;">
          <h2 style="margin-bottom:4px;">${opts.docTypeLabel} 결재 요청</h2>
          <p style="color:#555;">${opts.toName}님(${opts.approverRole}), 결재해 주실 문서가 도착했습니다.</p>
          <table style="border-collapse:collapse; margin:16px 0; font-size:14px;">
            <tr><td style="padding:4px 16px 4px 0; color:#888;">기안번호</td><td>${opts.draftNumber}</td></tr>
            <tr><td style="padding:4px 16px 4px 0; color:#888;">기안자</td><td>${opts.authorName}</td></tr>
          </table>
          <a href="${APP_BASE_URL}" style="display:inline-block; padding:10px 22px; background:#4f46e5; color:#fff; text-decoration:none; border-radius:8px; font-weight:bold;">사이트에서 확인하기</a>
        </div>
      `
    });
    console.log(`[mailer] ${opts.toEmail}에게 결재 요청 이메일 발송 완료`);
  } catch (err) {
    console.error(`[mailer] ${opts.toEmail}에게 이메일 발송 실패:`, err);
  }
}

// [추가] 업무일지(일일/주간) 캘린더 일정에 동료를 초대했을 때 보내는 실제 알림 메일.
// 결재 요청 메일(sendApprovalRequestEmail)과 같은 방식(Brevo API)을 그대로 재사용한다.
async function sendWorkLogInviteEmail(opts: {
  toEmail: string; toName: string; inviterName: string; title: string; date: string;
}) {
  if (!isMailerConfigured) {
    console.warn(`[mailer] 미설정 상태라 ${opts.toEmail}에게 업무일지 초대 이메일을 보내지 못했습니다.`);
    return;
  }
  try {
    await sendEmail({
      to: opts.toEmail,
      toName: opts.toName,
      subject: `[일정 초대] ${opts.inviterName}님이 ${opts.date} 일정에 초대했습니다`,
      html: `
        <div style="font-family: 'Malgun Gothic', sans-serif; padding: 24px; color:#111;">
          <h2 style="margin-bottom:4px;">업무일지 일정 초대</h2>
          <p style="color:#555;">${opts.toName}님, ${opts.inviterName}님이 아래 일정에 초대했습니다.</p>
          <table style="border-collapse:collapse; margin:16px 0; font-size:14px;">
            <tr><td style="padding:4px 16px 4px 0; color:#888;">일정 제목</td><td>${opts.title || '(제목 없음)'}</td></tr>
            <tr><td style="padding:4px 16px 4px 0; color:#888;">날짜</td><td>${opts.date}</td></tr>
            <tr><td style="padding:4px 16px 4px 0; color:#888;">초대한 사람</td><td>${opts.inviterName}</td></tr>
          </table>
          <a href="${APP_BASE_URL}" style="display:inline-block; padding:10px 22px; background:#059669; color:#fff; text-decoration:none; border-radius:8px; font-weight:bold;">사이트에서 확인하기</a>
        </div>
      `
    });
    console.log(`[mailer] ${opts.toEmail}에게 업무일지 초대 이메일 발송 완료`);
  } catch (err) {
    console.error(`[mailer] ${opts.toEmail}에게 이메일 발송 실패:`, err);
  }
}

// [추가] 업무일지 저장(등록/수정) 시, 새로 추가된 초대 대상(beforeIds에는 없었는데 afterIds에는
// 있는 사람)에게만 알림 메일을 보낸다. 이미 초대되어 있던 사람에게 저장할 때마다 매번 다시
// 메일이 가지 않도록 "새로 추가된 사람"만 골라낸다. 본인을 스스로 초대한 경우는 제외한다.
function notifyNewWorkLogInvites(opts: {
  inviterId: string; inviterName: string; title: string; date: string;
  beforeIds?: string[]; afterIds?: string[];
}) {
  const newIds = (opts.afterIds || []).filter((id) => id && id !== opts.inviterId && !(opts.beforeIds || []).includes(id));
  for (const uid of newIds) {
    const target = users.find(u => u.id === uid);
    if (!target) continue;
    sendWorkLogInviteEmail({
      toEmail: target.email,
      toName: target.name,
      inviterName: opts.inviterName,
      title: opts.title,
      date: opts.date
    }).catch((err) => console.error('[mailer] 업무일지 초대 이메일 발송 중 오류:', err));
  }
}

// ------------------------------------------------------------------
// 💬 전체 문의하기 (Feedback) — 명함뿐 아니라 앱 전체 어디서나 접수 가능
// 회사별로 나뉘지 않고 개발자(운영자)에게 전부 모이도록, 고정된 전역 스코프에 저장한다.
// ------------------------------------------------------------------
const GLOBAL_FEEDBACK_SCOPE = '__global_feedback__';

app.post('/api/feedback', async (req, res) => {
  try {
    const { category, content, pageContext } = req.body;
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: '문의 내용을 입력해주세요.' });
    }

    const userId = req.headers['x-user-id'] as string;
    const user = users.find(u => u.id === userId);

    const item: FeedbackItem = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      category: (['bug', 'feature', 'other'].includes(category) ? category : 'other'),
      content: String(content).trim(),
      authorName: user?.name,
      authorEmail: user?.email,
      authorPhone: user?.phone,
      companyName: user?.companyName,
      pageContext: pageContext || undefined,
      status: 'new',
      createdAt: new Date().toISOString()
    };

    await setScopedDoc(GLOBAL_FEEDBACK_SCOPE, 'feedback', item);
    res.status(201).json({ success: true });

    // 이메일 알림은 실패해도 사용자 응답에는 영향 없도록 응답을 먼저 보낸 뒤 처리(fire-and-forget)
    if (isMailerConfigured) {
      const categoryLabel = item.category === 'bug' ? '🐞 버그 신고' : item.category === 'feature' ? '💡 기능 제안' : '✉️ 기타 문의';
      sendEmail({
        to: ADMIN_EMAIL,
        subject: `[BizCard Pro 문의] ${categoryLabel} - ${item.authorName || '익명'}`,
        html: `
          <div style="font-family: 'Malgun Gothic', sans-serif; padding: 24px; color:#111;">
            <h2 style="margin-bottom:4px;">${categoryLabel}</h2>
            <p style="color:#555;">작성자: ${item.authorName || '알 수 없음'} (${item.authorEmail || '-'})</p>
            <p style="color:#555;">연락처: ${item.authorPhone || '등록된 번호 없음'}</p>
            <p style="color:#555;">소속: ${item.companyName || '개인 계정'}</p>
            <p style="color:#555;">접수 화면: ${item.pageContext || '-'}</p>
            <div style="margin-top:16px; padding:16px; background:#f8fafc; border-radius:8px; white-space:pre-wrap; font-size:14px;">${String(item.content).replace(/</g, '&lt;')}</div>
          </div>
        `
      }).then(() => {
        console.log('[mailer] 문의 접수 알림 메일 발송 완료');
      }).catch((err: unknown) => {
        console.error('[mailer] 문의 접수 알림 메일 발송 실패:', err);
      });
    }
  } catch (err: unknown) {
    console.error('Feedback submit error:', err);
    if (!res.headersSent) res.status(500).json({ error: '문의 접수 중 오류가 발생했습니다.' });
  }
});

// ------------------------------------------------------------------
// 📊 운영자 대시보드 — 회사별 가입/사용 현황을 한눈에 보기 위한 통계 API.
// 다른 회사의 데이터 규모(명함/차량/프로젝트 개수 등)까지 노출되는 민감한 정보라,
// 개발자(운영자) 계정에서만 접근 가능하도록 제한한다.
// ------------------------------------------------------------------
// [수정] 운영 관리자 이메일이 코드에 하드코딩돼 있으면, 나중에 담당자가 바뀔 때마다
// 코드를 고치고 재배포해야 한다. 반드시 환경변수로 설정해야 한다.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

// ADMIN_EMAIL 필수 검증
if (!ADMIN_EMAIL) {
  console.error('❌ ADMIN_EMAIL 환경변수가 설정되지 않았습니다. 관리자 기능을 사용할 수 없습니다.');
}

app.get('/api/admin/platform-stats', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester || requester.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }

  try {
    const scopeStats = await getPlatformStats();

    // 회사별 가입 직원 수/명단은 users 목록에서 같은 스코프(회사)로 묶어서 계산한다.
    const usersByScope = new Map<string, { count: number; companyName?: string; businessNumber?: string; members: { name: string; email: string; phone?: string; position?: string; createdAt?: string }[] }>();
    for (const u of users) {
      const scopeId = scopeIdForUser(u);
      if (!usersByScope.has(scopeId)) {
        usersByScope.set(scopeId, { count: 0, companyName: u.companyName, businessNumber: u.businessNumber, members: [] });
      }
      const entry = usersByScope.get(scopeId)!;
      entry.count += 1;
      entry.members.push({ name: u.name, email: u.email, phone: u.phone, position: u.position, createdAt: u.createdAt });
    }

    const companies = scopeStats
      .filter(s => s.scopeId.startsWith('company:'))
      .map(s => {
        const userInfo = usersByScope.get(s.scopeId);
        return {
          scopeId: s.scopeId,
          companyName: userInfo?.companyName || s.scopeId.replace('company:', ''),
          businessNumber: userInfo?.businessNumber || '',
          userCount: userInfo?.count || 0,
          members: userInfo?.members || [],
          itemCounts: s.itemCounts,
          totalItems: s.totalItems,
          lastActivity: s.lastActivity
        };
      })
      .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));

    // 아직 아무 데이터도 등록하지 않은(가입만 한) 회사도 목록에 나오도록, users에는 있지만
    // scoped_items에는 아직 없는 회사 스코프도 0건짜리 항목으로 추가해준다.
    const seenScopeIds = new Set(companies.map(c => c.scopeId));
    for (const [scopeId, info] of usersByScope) {
      if (scopeId.startsWith('company:') && !seenScopeIds.has(scopeId)) {
        companies.push({
          scopeId,
          companyName: info.companyName || scopeId.replace('company:', ''),
          businessNumber: info.businessNumber || '',
          userCount: info.count,
          members: info.members,
          itemCounts: {},
          totalItems: 0,
          lastActivity: null
        });
      }
    }

    // [수정] 개인 가입자는 그동안 숫자로만 집계됐는데, 실제로는 이름/이메일/가입일 정보가 있으므로
    // 목록으로 그대로 보여준다 (가입일 기록 이전에 가입한 계정은 createdAt이 없을 수 있음).
    const individuals = users
      .filter(u => u.type === 'individual')
      .map(u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt }))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    const individualScopeCount = scopeStats.filter(s => s.scopeId.startsWith('individual:')).length;

    // 기능별 전체 사용 빈도 (모든 회사 합산) - 어느 기능이 제일 많이 쓰이는지 파악용
    // [추가] 회사도 개인 가입자와 마찬가지로, 그 회사에서 가장 최근에 가입한 사람 기준으로
    // 최신순(최근 가입자가 있는 회사가 위) 정렬해서 응답한다.
    const latestMemberJoin = (c: typeof companies[number]) =>
      Math.max(0, ...c.members.map((m) => (m.createdAt ? new Date(m.createdAt).getTime() : 0)));
    companies.sort((a, b) => latestMemberJoin(b) - latestMemberJoin(a));

    const featureTotals: Record<string, number> = {};
    for (const s of scopeStats) {
      for (const [collection, count] of Object.entries(s.itemCounts)) {
        featureTotals[collection] = (featureTotals[collection] || 0) + (count as number);
      }
    }

    res.json({
      totalUsers: users.length,
      totalCompanies: companies.length,
      individualAccountCount: individualScopeCount,
      companies,
      individuals,
      featureTotals
    });
  } catch (err: unknown) {
    console.error('platform-stats 조회 오류:', err);
    res.status(500).json({ error: '통계 조회 중 오류가 발생했습니다.' });
  }
});

// ------------------------------------------------------------------
// 🔧 운영자 전용: 스코프(회사) 데이터 병합 도구.
// 예전에 사업자번호 필드가 잘못 저장되어(예: "회사명_사업자번호" 형태) 데이터가
// 엉뚱한 스코프에 쌓여있는 경우, 그 데이터를 올바른 스코프로 옮기기 위한 일회성 도구.
// "가져올 스코프"의 모든 컬렉션(명함/프로젝트/차량 등)을 "옮길 대상 스코프"로 이동시키고,
// 예전 스코프는 비운다. 되돌릴 수 없으니 반드시 fromScopeId/toScopeId를 신중히 확인할 것.
// ------------------------------------------------------------------
// [수정] myProfile은 다른 컬렉션(contacts, projects 등)과 저장 방식이 다르다 — "항목 여러 개
// (각자 id 있음)"가 아니라 "스코프당 문서 딱 하나"(doc_id가 항상 'profile' 고정)라서, 아래
// 목록형 병합 로직(item.id를 doc_id로 써서 저장)에 넣으면 doc_id가 비어서 저장이 실패한다.
// 그래서 목록에서 빼고 별도로 처리한다.
const MIGRATABLE_COLLECTIONS = [
  'contacts', 'projects', 'groups', 'vehicles', 'drivingLogs', 'expenses',
  'maintenances', 'maintenanceIntervals', 'dailyLogs', 'weeklyLogs',
  'advancePayments', 'leaveRequests', 'adminDocs'
] as const;

app.post('/api/admin/migrate-scope', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester || requester.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }

  const { fromScopeId, toScopeId } = req.body as { fromScopeId?: string; toScopeId?: string };
  if (!fromScopeId || !toScopeId || fromScopeId === toScopeId) {
    return res.status(400).json({ error: 'fromScopeId와 toScopeId를 서로 다르게 정확히 입력해주세요.' });
  }

  try {
    const summary: Record<string, number> = {};

    for (const name of MIGRATABLE_COLLECTIONS) {
      const oldItems = await getScopedCollection<{ id: string }>(fromScopeId, name);
      if (!oldItems || oldItems.length === 0) continue;

      const newItems = await getScopedCollection<{ id: string }>(toScopeId, name);
      const merged = [...(newItems || []), ...oldItems];

      await replaceScopedCollection(toScopeId, name, merged);
      await replaceScopedCollection(fromScopeId, name, []);

      summary[name] = oldItems.length;
    }

    // [추가] myProfile은 "옮길 대상(to) 스코프의 프로필이 비어있을 때만" 예전(from) 스코프의
    // 프로필로 채워준다 (to 쪽에 이미 실제 프로필이 있으면 그걸 함부로 덮어쓰지 않는다).
    const oldProfileList = await getScopedCollection<MyProfile>(fromScopeId, 'myProfile');
    const oldProfile = oldProfileList[0];
    if (oldProfile) {
      const newProfileList = await getScopedCollection<MyProfile>(toScopeId, 'myProfile');
      const newProfile = newProfileList[0];
      const toIsEmpty = !newProfile || (!newProfile.name && !newProfile.company && !newProfile.phoneMobile);
      if (toIsEmpty) {
        await setScopedProfile(toScopeId, oldProfile);
        summary['myProfile'] = 1;
      }
    }

    // 메모리 캐시를 지워서, 다음 접근 시 Supabase에서 최신 상태로 다시 불러오게 한다.
    delete db[fromScopeId];
    delete db[toScopeId];

    res.json({ success: true, fromScopeId, toScopeId, migratedCounts: summary });
  } catch (err: unknown) {
    console.error('scope migrate 오류:', err);
    res.status(500).json({ error: '데이터 병합 중 오류가 발생했습니다.' });
  }
});

// [추가] scoped_items의 데이터를 app_users.data로 마이그레이션하는 엔드포인트
// 성능 최적화용: getUsers()는 이미 실시간 병합을 수행하므로 필수는 아니지만,
// 이 API를 한 번 호출하면 모든 scoped_items이 app_users.data로 이동되어 조회 성능 향상
app.post('/api/admin/migrate-scoped-items', async (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = users.find(u => u.id === userId);
  if (!requester || requester.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: '접근 권한이 없습니다.' });
  }

  try {
    const result = await migrateScopedItemsToAppUsers();

    if (result.success) {
      // 마이그레이션 완료 후 메모리 캐시 갱신
      users = await getUsers();
      res.json({
        success: true,
        message: `${result.migratedUsers}/${result.totalUsers} 사용자의 데이터를 마이그레이션했습니다.`,
        ...result
      });
    } else {
      res.status(500).json({
        success: false,
        error: '마이그레이션 중 오류가 발생했습니다.',
        ...result
      });
    }
  } catch (err: unknown) {
    console.error('scoped_items 마이그레이션 오류:', err);
    res.status(500).json({ error: '마이그레이션 중 오류가 발생했습니다.' });
  }
});

// 접수된 문의 목록 조회 (관리자용 문의함 화면에서 사용)
// 문의함은 개발자 계정만 볼 수 있다. 세션으로 확인된 x-user-id(미들웨어가 채움)의 이메일로 판단한다.
const isDeveloperRequest = (req: express.Request): boolean => {
  const uid = req.headers['x-user-id'] as string | undefined;
  const requester = uid ? users.find((u) => u.id === uid) : undefined;
  return !!requester && requester.email === 'parkhy5454@gmail.com';
};

app.get('/api/feedback', async (req, res) => {
  if (!isDeveloperRequest(req)) return res.status(403).json({ error: '권한이 없습니다.' });
  const list = await getScopedCollection<FeedbackItem>(GLOBAL_FEEDBACK_SCOPE, 'feedback');
  res.json(list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

// 문의 처리 상태 변경 (신규 → 처리중 → 완료)
app.put('/api/feedback/:id', async (req, res) => {
  if (!isDeveloperRequest(req)) return res.status(403).json({ error: '권한이 없습니다.' });
  try {
    const existing = await getScopedDoc<FeedbackItem>(GLOBAL_FEEDBACK_SCOPE, 'feedback', req.params.id);
    if (!existing) return res.status(404).json({ error: '해당 문의를 찾을 수 없습니다.' });
    const status = ['new', 'in_progress', 'resolved'].includes(req.body.status) ? req.body.status : existing.status;
    const updated: FeedbackItem = { ...existing, status };
    await setScopedDoc(GLOBAL_FEEDBACK_SCOPE, 'feedback', updated);
    res.json(updated);
  } catch (err: unknown) {
    console.error('Feedback status update error:', err);
    res.status(500).json({ error: '상태 변경 중 오류가 발생했습니다.' });
  }
});

// ------------------------------------------------------------------
// 📇 명함 초대(바이럴 루프) — 명함 상세보기에서 "이 분에게 앱 추천하기"를 보낸 이력을
// 회사(스코프) 단위로 기록한다. 실제 가입 전환 여부까지는 추적하지 않고, 발송 이력만 남긴다.
// ------------------------------------------------------------------
app.post('/api/invites', async (req, res) => {
  try {
    const scopeId = req.scopeId;
    const userId = req.headers['x-user-id'] as string;
    const user = users.find(u => u.id === userId);
    const record: InviteRecord = {
      id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      contactId: req.body.contactId,
      contactName: req.body.contactName,
      channel: (['sms', 'email', 'kakao', 'share', 'other'].includes(req.body.channel) ? req.body.channel : 'other'),
      sentByUserId: userId,
      sentByUserName: user?.name,
      sentAt: new Date().toISOString()
    };
    await setScopedDoc(scopeId, 'invites', record);
    res.status(201).json(record);
  } catch (err) {
    console.error('Invite log error:', err);
    res.status(500).json({ error: '초대 기록 저장에 실패했습니다.' });
  }
});

app.get('/api/invites', async (req, res) => {
  const scopeId = req.scopeId;
  const list = await getScopedCollection<InviteRecord>(scopeId, 'invites');
  res.json(list.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || '')));
});

// 결재라인에서 아직 서명(date)되지 않은 첫 번째 단계 = 다음 결재 대기자
function getNextPendingApprover(approvalLine: ApprovalStep[] = []): ApprovalStep | undefined {
  return approvalLine.find(s => !s.date);
}

// 결재선의 직책 문자열(예: "대표이사")과 가입자의 직책(User.position) 문자열을 비교할 때,
// 공백이나 대소문자 차이 때문에 매칭에 실패하지 않도록 정규화한다.
// (예: 결재선에는 "대표 이사", 직원 프로필에는 "대표이사"로 입력돼 있어도 같은 사람으로 매칭)
function normalizeApprovalRole(s: string): string {
  return s.trim().replace(/\s+/g, '').toLowerCase();
}

// 결재라인이 진전되어 "다음 결재 대기자"가 바뀌었을 때만(중복 발송 방지) 그 사람에게 이메일을 보낸다.
// - 신규 기안(beforeLine 없음): 첫 번째 결재자에게 발송
// - 결재 진행(beforeLine 있음): 다음 결재자가 바뀐 경우에만 발송
async function notifyNextApproverIfChanged(
  scopeId: string,
  docTypeLabel: string,
  draftNumber: string,
  authorName: string,
  afterLine: ApprovalStep[] | undefined,
  afterStatus: string | undefined,
  beforeLine?: ApprovalStep[]
) {
  if (!isMailerConfigured) return;
  if (afterStatus !== 'pending') return; // 승인 완료/반려된 문서는 알림 대상 아님
  if (!scopeId.startsWith('company:')) return; // 회사 계정이 아니면 결재라인-직원 매칭 불가

  const nextBefore = beforeLine ? getNextPendingApprover(beforeLine) : undefined;
  const nextAfter = getNextPendingApprover(afterLine || []);
  if (!nextAfter) return;
  if (beforeLine && nextBefore?.role === nextAfter.role && nextBefore?.date === nextAfter.date) return; // 변화 없음

  const target = users.find(u => scopeIdForUser(u) === scopeId && normalizeApprovalRole(u.position || '') === normalizeApprovalRole(nextAfter.role));
  if (!target) {
    console.warn(`[mailer] "${nextAfter.role}" 직책을 가진 가입자를 찾지 못해 결재 요청 이메일을 보내지 못했습니다. (직원 관리에서 직책을 지정해주세요)`);
    return;
  }
  await sendApprovalRequestEmail({
    toEmail: target.email,
    toName: target.name,
    approverRole: nextAfter.role,
    docTypeLabel,
    draftNumber,
    authorName
  });
}

// [추가] 전자결재(가지급금 정산서/휴가 신청서/공문서) 동시 승인 충돌 감지.
// 두 결재자가 거의 동시에 같은 문서를 승인/반려하면, 이전에는 나중에 도착한 요청이
// {...before, ...req.body} 방식으로 통째로 덮어써서 먼저 처리된 결재 내용이 조용히
// 사라지는 문제가 있었다(예: A가 승인한 직후 B가 반려하면, A의 승인 흔적이 사라짐).
// 클라이언트가 자기가 화면에 표시하고 있던 문서의 updatedAt을 expectedUpdatedAt으로
// 같이 보내면, 그 사이 다른 사람이 먼저 저장해서 서버 쪽 updatedAt이 달라졌을 때 이를
// 감지해 409로 거부한다. expectedUpdatedAt을 안 보내는 요청(예: 일반 폼 수정 저장)은
// 기존과 동일하게 그대로 통과시킨다 - 승인/반려처럼 "다른 사람의 결정과 충돌하면 안 되는"
// 요청에서만 클라이언트가 이 값을 채워 보낸다.
function hasApprovalUpdateConflict(before: { updatedAt?: string }, reqBody: { expectedUpdatedAt?: unknown }): boolean {
  const expected = reqBody?.expectedUpdatedAt;
  if (!expected) return false;
  return !!before.updatedAt && before.updatedAt !== expected;
}

// 전자결재: 가지급금 정산서 CRUD
app.get('/api/approvals/advance', (req, res) => {
  const dbData = getScopedData(req);
  res.json(dbData.advancePayments || []);
});

app.post('/api/approvals/advance', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const doc: AdvancePaymentSettlement = req.body;
  if (!doc.id) doc.id = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!doc.createdAt) doc.createdAt = new Date().toISOString();
  doc.updatedAt = new Date().toISOString();
  if (!doc.items) doc.items = [];
  if (!doc.status) doc.status = 'pending';
  // [수정] 정산 항목에 직접 첨부한 영수증 사진이 base64로 들어오면 Storage로 올린다.
  // (차량비용/정비/업무일지에서 "가져오기"한 항목은 원본이 이미 URL이라 여기서는 손 안 대고
  // 그대로 통과한다 - persistImageField가 data:image/로 시작하지 않으면 값을 그대로 반환)
  doc.items = (await persistReceiptImagesInArray(scopeId, doc.items, `advance-${doc.id}`)) || [];

  dbData.advancePayments = dbData.advancePayments || [];
  dbData.advancePayments.unshift(doc);
  // [수정] 영수증 스캔본이 포함된 정산서 저장이 DB에 실제로 실패했는데도 조용히 "성공"으로
  // 응답하던 문제를 고쳤다. 실패하면 방금 추가한 것을 되돌리고 알린다.
  const savedAdvance = await setScopedDoc(scopeId, 'advancePayments', doc);
  if (!savedAdvance) {
    dbData.advancePayments = dbData.advancePayments.filter((d: AdvancePaymentSettlement) => d.id !== doc.id);
    return res.status(500).json({ error: '가지급금 정산서를 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(doc);

  notifyNextApproverIfChanged(scopeId, '가지급금 정산서', `${doc.periodStart} ~ ${doc.periodEnd}`, doc.author, doc.approvalLine, doc.status)
    .catch(err => console.error('[mailer] 가지급금 정산서 결재 알림 처리 실패:', err));
});

app.put('/api/approvals/advance/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.advancePayments = dbData.advancePayments || [];
  const idx = dbData.advancePayments.findIndex((d: AdvancePaymentSettlement) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Advance payment settlement not found' });

  const before = dbData.advancePayments[idx];
  if (hasApprovalUpdateConflict(before, req.body)) {
    return res.status(409).json({ error: '다른 사람이 방금 이 문서를 먼저 처리했습니다. 새로고침 후 다시 확인해주세요.', current: before });
  }
  const updated = { ...before, ...req.body, updatedAt: new Date().toISOString() };
  // [수정] POST와 동일: 수정 시 새로 추가/변경된 영수증 사진도 Storage로 옮긴다.
  updated.items = (await persistReceiptImagesInArray(scopeId, updated.items, `advance-${updated.id}`)) || [];
  dbData.advancePayments[idx] = updated;
  // [수정] 위 등록(POST)과 동일한 이유로, 저장 실패를 조용히 넘기지 않고 되돌린 뒤 알린다.
  const savedAdvanceUpdate = await setScopedDoc(scopeId, 'advancePayments', updated);
  if (!savedAdvanceUpdate) {
    dbData.advancePayments[idx] = before;
    return res.status(500).json({ error: '가지급금 정산서 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(updated);

  notifyNextApproverIfChanged(scopeId, '가지급금 정산서', `${updated.periodStart} ~ ${updated.periodEnd}`, updated.author, updated.approvalLine, updated.status, before.approvalLine)
    .catch(err => console.error('[mailer] 가지급금 정산서 결재 알림 처리 실패:', err));
});

app.delete('/api/approvals/advance/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.advancePayments = dbData.advancePayments || [];
  dbData.advancePayments = dbData.advancePayments.filter((d: AdvancePaymentSettlement) => d.id !== req.params.id);
  await deleteScopedDoc(scopeId, 'advancePayments', req.params.id);
  res.json({ success: true });
});

// [추가] "연차 현황"이 전자결재 > 휴가 신청서와 자동으로 연동되도록 - 휴가 신청서가
// 최종 승인(status === 'approved', leaveCategory === 'annual')되는 순간, 사람이 수동으로
// "전자결재에서 불러오기" 버튼을 누르지 않아도 자동으로 그 해의 "연차 현황" 문서에 반영한다.
// 업무일지 차량비용 동기화(syncWorkLogExpenses)와 같은 방식으로, 여기서는 dbData만 직접
// 고쳐놓고 실제 저장(setScopedDoc)은 호출한 쪽에서 한다.
function findOrCreateAnnualLeaveStatusDoc(dbData: ScopedData, year: string): AdminDoc {
  dbData.adminDocs = dbData.adminDocs || [];
  let doc = dbData.adminDocs.find((d: AdminDoc) => d.category === 'annual_leave_status' && d.annualLeaveStatus?.year === year);
  if (!doc) {
    doc = {
      id: `adoc-al-${year}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      section: 'management',
      category: 'annual_leave_status',
      title: `${year}년 연차 현황`,
      date: `${year}-01-01`,
      createdAt: new Date().toISOString(),
      annualLeaveStatus: { year, people: [] }
    } as AdminDoc;
    dbData.adminDocs.unshift(doc);
  }
  if (!doc.annualLeaveStatus) doc.annualLeaveStatus = { year, people: [] };
  return doc;
}

// 승인된 연차 신청서 1건을 "연차 현황"의 해당 연도 문서에 반영(같은 이름의 직원이 이미
// 있으면 그 사람의 연차 사용 내역에 추가/갱신, 없으면 새 직원 줄을 만들어 추가)한다.
// 승인 상태가 아니거나 연차(annual)가 아니면 아무 것도 하지 않고 null을 반환한다.
function syncApprovedAnnualLeaveToStatus(dbData: ScopedData, leaveReq: LeaveRequest): AdminDoc | null {
  if (leaveReq.status !== 'approved' || leaveReq.leaveCategory !== 'annual') return null;
  const author = (leaveReq.author || '').trim();
  if (!author || !leaveReq.startDate) return null;
  const year = leaveReq.startDate.slice(0, 4);
  const doc = findOrCreateAnnualLeaveStatusDoc(dbData, year);
  const sourceKey = `leave_request:${leaveReq.id}`;

  let person = doc.annualLeaveStatus!.people.find((p) => (p.name || '').trim() === author);
  if (!person) {
    person = {
      id: `alp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: author,
      hireDate: '',
      totalAnnualDays: leaveReq.totalAnnualDays || 0,
      leaveEntries: [],
      overtimeEntries: [],
      substituteEntries: []
    };
    doc.annualLeaveStatus!.people.push(person);
  } else if (!person.totalAnnualDays && leaveReq.totalAnnualDays) {
    person.totalAnnualDays = leaveReq.totalAnnualDays;
  }

  const entryPatch = {
    startDate: leaveReq.startDate,
    endDate: leaveReq.endDate,
    days: leaveReq.days,
    note: leaveReq.reason || '',
    sourceKey,
    sourceLabel: '전자결재 휴가 신청서'
  };
  const existingIdx = person.leaveEntries.findIndex((e) => e.sourceKey === sourceKey);
  if (existingIdx === -1) {
    person.leaveEntries.push({ id: `ale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...entryPatch });
  } else {
    person.leaveEntries[existingIdx] = { ...person.leaveEntries[existingIdx], ...entryPatch };
  }
  return doc;
}

// 승인 취소/반려, 연차→다른 종류로 변경, 대상 연도 변경 등으로 더 이상 자동 반영 대상이
// 아니게 된 신청서가 예전에 자동으로 채워 넣었던 내역을 전부 찾아서 지운다. 연도가 바뀐
// 경우까지 놓치지 않도록 모든 "연차 현황" 문서를 훑는다.
function removeSyncedAnnualLeaveEntry(dbData: ScopedData, leaveReqId: string): AdminDoc[] {
  dbData.adminDocs = dbData.adminDocs || [];
  const sourceKey = `leave_request:${leaveReqId}`;
  const affected: AdminDoc[] = [];
  for (const doc of dbData.adminDocs) {
    if (doc.category !== 'annual_leave_status' || !doc.annualLeaveStatus) continue;
    let changed = false;
    for (const person of doc.annualLeaveStatus.people) {
      const before = person.leaveEntries.length;
      person.leaveEntries = person.leaveEntries.filter((e) => e.sourceKey !== sourceKey);
      if (person.leaveEntries.length !== before) changed = true;
    }
    if (changed) affected.push(doc);
  }
  return affected;
}

// 전자결재: 휴가 신청서 CRUD
app.get('/api/approvals/leave', (req, res) => {
  const dbData = getScopedData(req);
  res.json(dbData.leaveRequests || []);
});

app.post('/api/approvals/leave', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const doc: LeaveRequest = req.body;
  if (!doc.id) doc.id = `lv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!doc.createdAt) doc.createdAt = new Date().toISOString();
  doc.updatedAt = new Date().toISOString();
  if (!doc.status) doc.status = 'pending';

  dbData.leaveRequests = dbData.leaveRequests || [];
  dbData.leaveRequests.unshift(doc);

  // [추가] 등록과 동시에 이미 승인 상태로 만들어지는 경우(드물지만)에 대비해 여기서도 동기화한다.
  const syncedAnnualLeaveDocOnCreate = syncApprovedAnnualLeaveToStatus(dbData, doc);

  await Promise.all([
    setScopedDoc(scopeId, 'leaveRequests', doc),
    ...(syncedAnnualLeaveDocOnCreate ? [setScopedDoc(scopeId, 'adminDocs', syncedAnnualLeaveDocOnCreate)] : [])
  ]);
  res.status(201).json(doc);

  notifyNextApproverIfChanged(scopeId, '휴가 신청서', doc.draftNumber, doc.author, doc.approvalLine, doc.status)
    .catch(err => console.error('[mailer] 휴가 신청서 결재 알림 처리 실패:', err));
});

app.put('/api/approvals/leave/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.leaveRequests = dbData.leaveRequests || [];
  const idx = dbData.leaveRequests.findIndex((d: LeaveRequest) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Leave request not found' });

  const before = dbData.leaveRequests[idx];
  if (hasApprovalUpdateConflict(before, req.body)) {
    return res.status(409).json({ error: '다른 사람이 방금 이 문서를 먼저 처리했습니다. 새로고침 후 다시 확인해주세요.', current: before });
  }
  const updated = { ...before, ...req.body, updatedAt: new Date().toISOString() };
  dbData.leaveRequests[idx] = updated;

  // [추가] "연차 현황" 자동 동기화 - 이전에 자동으로 넣어줬던 내역을 먼저 지운 뒤(대상
  // 연도가 바뀐 경우까지 포함), 지금 상태 기준으로 다시 반영한다. 최종 승인 상태가 아니게
  // 됐으면 removeSyncedAnnualLeaveEntry만 효과가 있고 syncApprovedAnnualLeaveToStatus는
  // null을 반환해 아무 것도 새로 넣지 않는다.
  const removedAnnualLeaveDocs = removeSyncedAnnualLeaveEntry(dbData, updated.id);
  const syncedAnnualLeaveDoc = syncApprovedAnnualLeaveToStatus(dbData, updated);
  const affectedAnnualLeaveDocs = new Map<string, AdminDoc>();
  for (const d of removedAnnualLeaveDocs) affectedAnnualLeaveDocs.set(d.id, d);
  if (syncedAnnualLeaveDoc) affectedAnnualLeaveDocs.set(syncedAnnualLeaveDoc.id, syncedAnnualLeaveDoc);

  await Promise.all([
    setScopedDoc(scopeId, 'leaveRequests', updated),
    ...Array.from(affectedAnnualLeaveDocs.values()).map((d) => setScopedDoc(scopeId, 'adminDocs', d))
  ]);
  res.json(updated);

  notifyNextApproverIfChanged(scopeId, '휴가 신청서', updated.draftNumber, updated.author, updated.approvalLine, updated.status, before.approvalLine)
    .catch(err => console.error('[mailer] 휴가 신청서 결재 알림 처리 실패:', err));
});

app.delete('/api/approvals/leave/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.leaveRequests = dbData.leaveRequests || [];
  dbData.leaveRequests = dbData.leaveRequests.filter((d: LeaveRequest) => d.id !== req.params.id);
  await deleteScopedDoc(scopeId, 'leaveRequests', req.params.id);
  res.json({ success: true });
});

// [추가] 전자결재: 공문서(대외 발송용 공식 문서) CRUD. 가지급금 정산서/휴가 신청서와
// 완전히 동일한 스코프별 저장/알림 패턴을 그대로 따른다.
app.get('/api/approvals/official', (req, res) => {
  const dbData = getScopedData(req);
  res.json(dbData.officialDocuments || []);
});

app.post('/api/approvals/official', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const doc: OfficialDocument = req.body;
  if (!doc.id) doc.id = `of-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!doc.createdAt) doc.createdAt = new Date().toISOString();
  doc.updatedAt = new Date().toISOString();
  if (!doc.bodyParagraphs) doc.bodyParagraphs = [];
  if (!doc.status) doc.status = 'pending';

  dbData.officialDocuments = dbData.officialDocuments || [];
  dbData.officialDocuments.unshift(doc);
  await setScopedDoc(scopeId, 'officialDocuments', doc);
  res.status(201).json(doc);

  notifyNextApproverIfChanged(scopeId, '공문서', doc.executionNumber, doc.author, doc.approvalLine, doc.status)
    .catch(err => console.error('[mailer] 공문서 결재 알림 처리 실패:', err));
});

app.put('/api/approvals/official/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.officialDocuments = dbData.officialDocuments || [];
  const idx = dbData.officialDocuments.findIndex((d: OfficialDocument) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Official document not found' });

  const before = dbData.officialDocuments[idx];
  if (hasApprovalUpdateConflict(before, req.body)) {
    return res.status(409).json({ error: '다른 사람이 방금 이 문서를 먼저 처리했습니다. 새로고침 후 다시 확인해주세요.', current: before });
  }
  const updated = { ...before, ...req.body, updatedAt: new Date().toISOString() };
  dbData.officialDocuments[idx] = updated;
  await setScopedDoc(scopeId, 'officialDocuments', updated);
  res.json(updated);

  notifyNextApproverIfChanged(scopeId, '공문서', updated.executionNumber, updated.author, updated.approvalLine, updated.status, before.approvalLine)
    .catch(err => console.error('[mailer] 공문서 결재 알림 처리 실패:', err));
});

app.delete('/api/approvals/official/:id', async (req, res) => {
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.officialDocuments = dbData.officialDocuments || [];
  dbData.officialDocuments = dbData.officialDocuments.filter((d: OfficialDocument) => d.id !== req.params.id);
  await deleteScopedDoc(scopeId, 'officialDocuments', req.params.id);
  res.json({ success: true });
});

// [추가] 홈 대시보드의 "내 결재 대기" 카드용 요약 엔드포인트. 가지급금 정산서/휴가 신청서/
// 공문서 세 종류를 각각 통째로 불러오지 않고, 로그인한 사람의 직책(User.position)이 결재선의
// "다음 미결 단계" 직책과 일치하는 pending 문서 개수만 가볍게 계산해서 돌려준다(첨부 영수증
// 이미지 등 무거운 데이터를 포함하지 않음). 직책이 결재선 어디에도 없으면(예: 결재 단계에
// 없는 직책이거나 개인 계정) 항상 0건으로, 다른 직원의 결재 건수가 새어나가지 않는다.
app.get('/api/approvals/pending-count', (req, res) => {
  const userId = req.headers['x-user-id'] as string;
  const requester = userId ? users.find(u => u.id === userId) : undefined;
  if (!requester) return res.status(401).json({ error: '로그인이 필요합니다.' });

  const myRole = normalizeApprovalRole(requester.position || '');
  if (!myRole) return res.json({ count: 0, byType: { advance: 0, leave: 0, official: 0 } });

  const dbData = getScopedData(req);
  const countMine = (docs: { status: string; approvalLine?: ApprovalStep[] }[] | undefined): number =>
    (docs || []).filter((d) => {
      if (d.status !== 'pending') return false;
      const next = getNextPendingApprover(d.approvalLine || []);
      return !!next && normalizeApprovalRole(next.role) === myRole;
    }).length;

  const advance = countMine(dbData.advancePayments);
  const leave = countMine(dbData.leaveRequests);
  const official = countMine(dbData.officialDocuments);
  res.json({ count: advance + leave + official, byType: { advance, leave, official } });
});

// ------------------------------------------------------------------
// 📁 경영지원 / 회계관리 - 관리자만 접근 가능한 회사 서류·장부 보관함
// [추가] 근로계약서, 급여명세서 등 12개 서류 종류를 하나의 공용 데이터(AdminDoc)로 다루고,
// category 필드로만 구분한다. 이 API 전체는 회사(company) 계정의 관리자(role: 'admin')만
// 쓸 수 있다 — 일반 직원은 물론, 같은 회사라도 관리자가 아니면 절대 접근할 수 없다.
// ------------------------------------------------------------------
function requireAdmin(req: express.Request, res: express.Response): RegisteredUser | null {
  const userId = req.headers['x-user-id'] as string;
  const requester = userId ? users.find(u => u.id === userId) : undefined;
  if (!requester || requester.role !== 'admin') {
    res.status(403).json({ error: '관리자만 접근할 수 있는 화면입니다.' });
    return null;
  }
  return requester;
}

app.get('/api/admin-docs', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);
  res.json(dbData.adminDocs || []);
});

app.post('/api/admin-docs', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  const doc: AdminDoc = req.body;
  if (!doc.id) doc.id = `adoc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!doc.createdAt) doc.createdAt = new Date().toISOString();
  doc.createdByUserId = requester.id;
  doc.createdByUserName = requester.name;
  doc.attachments = await persistAttachmentsInArray(scopeId, doc.attachments, `admindoc-${doc.id}`);

  dbData.adminDocs = dbData.adminDocs || [];
  dbData.adminDocs.unshift(doc);
  // [수정] 첨부파일(스캔본 포함)이 들어간 저장이 DB에 실제로 실패했는데도 조용히 "성공"으로
  // 응답하던 문제를 고쳤다. 실패하면 방금 추가한 것을 되돌리고 알린다.
  const savedAdminDoc = await setScopedDoc(scopeId, 'adminDocs', doc);
  if (!savedAdminDoc) {
    dbData.adminDocs = dbData.adminDocs.filter((d: AdminDoc) => d.id !== doc.id);
    return res.status(500).json({ error: '문서를 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.status(201).json(doc);
});

app.put('/api/admin-docs/:id', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.adminDocs = dbData.adminDocs || [];
  const idx = dbData.adminDocs.findIndex((d: AdminDoc) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Document not found' });

  const previousAdminDoc = dbData.adminDocs[idx];
  const updated: AdminDoc = { ...dbData.adminDocs[idx], ...req.body, id: req.params.id };
  if (updated.attachments) {
    updated.attachments = await persistAttachmentsInArray(scopeId, updated.attachments, `admindoc-${updated.id}`);
  }
  dbData.adminDocs[idx] = updated;
  // [수정] 위 등록(POST)과 동일한 이유로, 저장 실패를 조용히 넘기지 않고 되돌린 뒤 알린다.
  const savedAdminDocUpdate = await setScopedDoc(scopeId, 'adminDocs', updated);
  if (!savedAdminDocUpdate) {
    dbData.adminDocs[idx] = previousAdminDoc;
    return res.status(500).json({ error: '문서 수정 내용을 데이터베이스에 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  }
  res.json(updated);
});

app.delete('/api/admin-docs/:id', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);
  const scopeId = req.scopeId;
  dbData.adminDocs = dbData.adminDocs || [];
  dbData.adminDocs = dbData.adminDocs.filter((d: AdminDoc) => d.id !== req.params.id);
  await deleteScopedDoc(scopeId, 'adminDocs', req.params.id);
  res.json({ success: true });
});

// [추가] 경영지원 서류들(근로계약서/재직증명서 등)과 전자결재 공문서에서 반복해서 써야 하는
// "회사 사업체 주소·사업종류·전화/팩스/이메일·공문서 시행번호 접두어"를 한 번만 입력하면 다음부터
// 자동으로 불러와지도록, 회사 스코프에 하나만 저장해두는 간단한 설정값. 여러 문서를 만들 때마다
// 매번 다시 타이핑할 필요가 없게 한다.
// [수정] 조회(GET)는 공문서를 작성하는 일반 직원도 발신처 정보를 자동으로 채워 넣을 수 있어야
// 하므로 관리자 전용에서 로그인한 모든 사용자로 완화했다. 수정(PUT)은 기존과 동일하게 관리자만 가능.
app.get('/api/company-settings', async (req, res) => {
  const scopeId = req.scopeId;
  const list = await getScopedCollection<{ id: string; address?: string; businessType?: string; phone?: string; fax?: string; email?: string; docPrefix?: string }>(scopeId, 'companySettings');
  res.json(list[0] || { id: 'default', address: '', businessType: '', phone: '', fax: '', email: '', docPrefix: 'KS' });
});

app.put('/api/company-settings', async (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const scopeId = req.scopeId;
  // [수정] 예전엔 요청 본문에 없는 필드를 전부 빈 값으로 덮어써서, 예를 들어 공문서 탭에서
  // 전화/팩스만 저장해도 근로계약서 쪽에서 써둔 주소·사업종류가 날아가는 문제가 있었다.
  // 기존 값을 먼저 불러와 보낸 필드만 덮어쓰는 부분 업데이트(병합) 방식으로 바꾼다.
  const existingList = await getScopedCollection<CompanySettingsDoc>(scopeId, 'companySettings');
  const existing: CompanySettingsDoc = existingList[0] || {};
  const record = {
    id: 'default',
    address: req.body.address !== undefined ? req.body.address : (existing.address || ''),
    businessType: req.body.businessType !== undefined ? req.body.businessType : (existing.businessType || ''),
    phone: req.body.phone !== undefined ? req.body.phone : (existing.phone || ''),
    fax: req.body.fax !== undefined ? req.body.fax : (existing.fax || ''),
    email: req.body.email !== undefined ? req.body.email : (existing.email || ''),
    docPrefix: req.body.docPrefix !== undefined ? req.body.docPrefix : (existing.docPrefix || 'KS')
  };
  await setScopedDoc(scopeId, 'companySettings', record);
  res.json(record);
});

// [추가] "카드사용내역"이 통합 차량 관리(운행기록/비용관리/정비일지), 프로젝트,
// 업무일지(일일/주간)와 연동되도록 - 이 다섯 곳에 이미 "법인카드" 결제로 기록된 지출들을
// 전부 찾아서 한 목록으로 모아준다. 운행기록 자체엔 결제수단 항목이 없지만, 운행 중 스캔한
// 영수증은 비용관리(VehicleExpense)에 drivingLogId로 연결되어 저장되므로 비용관리를
// 훑으면 자연히 포함된다. 화면에서 이 목록 중 골라서 "카드사용내역"으로 가져올 수 있다.
app.get('/api/admin-docs/card-usage-candidates', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);

  const candidates: {
    sourceKey: string;
    sourceLabel: string;
    date: string;
    amount: number;
    project?: string;
    memo?: string;
    personName?: string;
  }[] = [];

  // 1) 통합 차량 관리 - 비용관리 (운행 중 스캔한 영수증도 여기 포함됨)
  for (const e of (dbData.expenses || [])) {
    if (e.payMethod !== 'company_card') continue;
    candidates.push({
      sourceKey: `vehicle_expense:${e.id}`,
      sourceLabel: '차량 비용관리',
      date: e.date,
      amount: e.amount,
      project: e.projectName,
      memo: e.merchantName || e.categoryCustom || e.category
    });
  }

  // 2) 통합 차량 관리 - 정비일지
  for (const m of (dbData.maintenances || [])) {
    if (m.payMethod !== 'company_card') continue;
    candidates.push({
      sourceKey: `vehicle_maintenance:${m.id}`,
      sourceLabel: '차량 정비일지',
      date: m.date,
      amount: m.cost,
      memo: `${m.title}${m.shopName ? ` (${m.shopName})` : ''}`
    });
  }

  // 3) 프로젝트 - 미팅/팔로우업 지출
  for (const p of (dbData.projects || [])) {
    for (const f of (p.followUps || [])) {
      for (const ex of (f.expenses || [])) {
        if (ex.payMethod !== 'company_card') continue;
        candidates.push({
          sourceKey: `project_expense:${ex.id}`,
          sourceLabel: '프로젝트',
          date: f.date,
          amount: ex.amount,
          project: p.name,
          memo: ex.memo || ex.categoryCustom || ex.category
        });
      }
    }
  }

  // 4) 업무일지(일일)
  for (const l of (dbData.dailyLogs || [])) {
    for (const ex of (l.expenses || [])) {
      if (ex.payMethod !== 'company_card') continue;
      candidates.push({
        sourceKey: `worklog_daily_expense:${ex.id}`,
        sourceLabel: '업무일지(일일)',
        date: l.date,
        amount: ex.amount,
        memo: ex.memo || ex.categoryCustom || ex.category,
        personName: l.author
      });
    }
  }

  // 5) 업무일지(주간)
  for (const l of (dbData.weeklyLogs || [])) {
    for (const ex of (l.expenses || [])) {
      if (ex.payMethod !== 'company_card') continue;
      candidates.push({
        sourceKey: `worklog_weekly_expense:${ex.id}`,
        sourceLabel: '업무일지(주간)',
        date: l.startDate,
        amount: ex.amount,
        memo: ex.memo || ex.categoryCustom || ex.category,
        personName: l.author
      });
    }
  }

  candidates.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(candidates);
});

// [추가] "해외 출장 경비"에서 카드로 결제한 항목(항공료/숙박비/식비/교통비/직원 선물/기타 등)을
// 회계관리 > 카드사용내역 + 업무일지(일일/주간)에서 "자동 불러오기"로 채울 수 있도록 후보를
// 모아준다. 두 곳을 같이 보여주되, 같은 지출이 두 번 잡히는 걸 막기 위해: 업무일지 지출이
// 이미 카드사용내역으로 한 번 가져와졌다면(카드사용내역 항목의 sourceKey가 그 업무일지
// 지출의 sourceKey와 같으면) 업무일지 쪽 후보는 빼고 카드사용내역 쪽만 남긴다 - "겹칠 때는
// 하나만 보이게" 요청에 맞춘 것. 카드사용내역 자체에 이미 업무일지 등에서 가져온 항목은
// sourceKey를 그대로 갖고 있으므로(위 card-usage-candidates 참고), 이 값들만 모아두면
// 중복을 정확히 걸러낼 수 있다.
app.get('/api/admin-docs/overseas-trip-card-candidates', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);

  const candidates: {
    sourceKey: string;
    sourceLabel: string;
    date: string;
    amount: number;
    project?: string;
    memo?: string;
    personName?: string;
  }[] = [];

  // 이미 카드사용내역에 등록된 항목들의 원본 sourceKey 모음 - 업무일지 지출 중 이 값과
  // 같은 sourceKey를 갖는 건(=이미 카드사용내역으로 한 번 가져와진 것)은 아래에서 뺀다.
  const reconciledToCardUsage = new Set<string>();
  for (const doc of (dbData.adminDocs || [])) {
    if (doc.category !== 'card_usage' || !doc.cardUsage) continue;
    for (const card of (doc.cardUsage.cards || [])) {
      for (const entry of (card.entries || [])) {
        // 1) 카드사용내역 항목 자체를 후보로 추가 (해외 출장 경비는 카드사용내역에 이미
        // 기록된 실제 결제 내역을 기준으로 가져오는 게 가장 정확하다).
        candidates.push({
          sourceKey: `card_usage_entry:${doc.id}:${card.id}:${entry.id}`,
          sourceLabel: '카드사용내역',
          date: entry.date,
          amount: Number(entry.amount) || 0,
          project: entry.project,
          memo: entry.note,
          personName: entry.user || card.holder
        });
        if (entry.sourceKey) reconciledToCardUsage.add(entry.sourceKey);
      }
    }
  }

  // 업무일지(일일) - 법인카드 결제 지출 중, 아직 카드사용내역으로 가져오지 않은 것만 추가
  for (const l of (dbData.dailyLogs || [])) {
    for (const ex of (l.expenses || [])) {
      if (ex.payMethod !== 'company_card') continue;
      const sourceKey = `worklog_daily_expense:${ex.id}`;
      if (reconciledToCardUsage.has(sourceKey)) continue;
      candidates.push({
        sourceKey,
        sourceLabel: '업무일지(일일)',
        date: l.date,
        amount: ex.amount,
        memo: ex.memo || ex.categoryCustom || ex.category,
        personName: l.author
      });
    }
  }

  // 업무일지(주간) - 위와 동일
  for (const l of (dbData.weeklyLogs || [])) {
    for (const ex of (l.expenses || [])) {
      if (ex.payMethod !== 'company_card') continue;
      const sourceKey = `worklog_weekly_expense:${ex.id}`;
      if (reconciledToCardUsage.has(sourceKey)) continue;
      candidates.push({
        sourceKey,
        sourceLabel: '업무일지(주간)',
        date: l.startDate,
        amount: ex.amount,
        memo: ex.memo || ex.categoryCustom || ex.category,
        personName: l.author
      });
    }
  }

  candidates.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(candidates);
});

// [추가] "가지급내역"이 전자결재 > 가지급금 정산서와 연동되도록 - 결재가 완전히 승인
// (status === 'approved')된 정산서의 정산 내역(items)을 전부 찾아서 한 목록으로 모아준다.
// 화면에서 이 목록 중 골라서 "가지급내역"의 해당 인원·해당 월 칸으로 자동 불러올 수 있다.
// (아직 결재 중이거나 반려된 정산서는 확정된 지급이 아니므로 포함하지 않는다.)
app.get('/api/admin-docs/advance-payment-candidates', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);

  const candidates: {
    sourceKey: string;
    sourceLabel: string;
    date: string;
    amount: number;
    personName?: string;
    project?: string;
    memo?: string;
  }[] = [];

  for (const settlement of (dbData.advancePayments || [])) {
    if (settlement.status !== 'approved') continue;
    for (const item of (settlement.items || [])) {
      candidates.push({
        sourceKey: `advance_settlement_item:${settlement.id}:${item.id}`,
        sourceLabel: '전자결재 가지급금 정산서',
        date: item.date,
        amount: item.amount,
        personName: settlement.author,
        project: item.project,
        memo: item.description
      });
    }
  }

  candidates.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(candidates);
});

// [추가] "연차 현황"이 전자결재 > 휴가 신청서와 연동되도록 - 완전히 승인(status ===
// 'approved')된 연차(leaveCategory === 'annual') 신청서를 전부 찾아서 한 목록으로 모아준다.
// 화면에서 이 목록을 사람 이름(author) 기준으로 자동으로 묶어서, 아직 등록 안 된 사람은
// 새 줄로 만들고 그 사람의 연차 사용 내역으로 채워 넣는다. totalAnnualDays(총 년차일수)도
// 신청서에 이미 적혀있는 값을 그대로 같이 내려줘서, 사람을 새로 등록할 때 자동으로 채워지게
// 한다. 대상 연도(year 쿼리)를 넘기면 그 해에 시작하는 신청서만 걸러서 돌려준다(연도별
// 현황판이므로 - 현금 흐름/관리비내역과 같은 "연도 하나 = 문서 하나" 방식).
app.get('/api/admin-docs/annual-leave-candidates', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const year = req.query.year as string | undefined;
  const dbData = getScopedData(req);

  const candidates: {
    sourceKey: string;
    sourceLabel: string;
    author: string;
    startDate: string;
    endDate?: string;
    days: number;
    note: string;
    totalAnnualDays?: number;
  }[] = [];

  for (const doc of (dbData.leaveRequests || [])) {
    if (doc.status !== 'approved') continue;
    if (doc.leaveCategory !== 'annual') continue;
    if (year && (doc.startDate || '').slice(0, 4) !== year) continue;
    candidates.push({
      sourceKey: `leave_request:${doc.id}`,
      sourceLabel: '전자결재 휴가 신청서',
      author: doc.author,
      startDate: doc.startDate,
      endDate: doc.endDate,
      days: doc.days,
      note: doc.reason,
      totalAnnualDays: doc.totalAnnualDays
    });
  }

  candidates.sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));
  res.json(candidates);
});

// [수정] "차량 과태료 내역"/"각종 세금"/"관리비내역" 세 곳 모두 회계관리 > 통장 출금
// 내역과 연동되도록 - 이미 등록된 통장 출금 내역(bank_withdrawal)의 거래 내역을 전부
// 찾아서 한 목록으로 모아주는 공용 엔드포인트로 일반화했다(원래는 차량 과태료 전용이었음).
// 출금 내역 자체엔 "이게 과태료/세금/관리비 중 무엇인지" 표시가 없어서(일반 거래와 똑같이
// 기록되므로) 전부 후보로 보여주고, 화면에서 각 탭에 맞는 건만 골라 가져오게 한다.
app.get('/api/admin-docs/bank-withdrawal-candidates', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);

  const candidates: {
    sourceKey: string;
    sourceLabel: string;
    date: string;
    amount: number;
    memo?: string;
  }[] = [];

  for (const doc of (dbData.adminDocs || [])) {
    if (doc.category !== 'bank_withdrawal' || !doc.bankLedger) continue;
    for (const acc of (doc.bankLedger.accounts || [])) {
      for (const entry of (acc.entries || [])) {
        candidates.push({
          sourceKey: `bank_withdrawal_entry:${doc.id}:${entry.id}`,
          sourceLabel: '통장 출금 내역',
          date: entry.date,
          amount: entry.amount,
          memo: [entry.description, entry.note].filter(Boolean).join(' · ')
        });
      }
    }
  }

  candidates.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(candidates);
});

// [추가] "현금 흐름"의 INFLOWS가 회계관리 > 통장 입금 내역과 연동되도록 - 위
// bank-withdrawal-candidates와 같은 방식으로, 이미 등록된 통장 입금 내역(bank_deposit)의
// 거래 내역을 전부 찾아서 한 목록으로 모아준다.
app.get('/api/admin-docs/bank-deposit-candidates', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);

  const candidates: {
    sourceKey: string;
    sourceLabel: string;
    date: string;
    amount: number;
    memo?: string;
  }[] = [];

  for (const doc of (dbData.adminDocs || [])) {
    if (doc.category !== 'bank_deposit' || !doc.bankLedger) continue;
    for (const acc of (doc.bankLedger.accounts || [])) {
      for (const entry of (acc.entries || [])) {
        candidates.push({
          sourceKey: `bank_deposit_entry:${doc.id}:${entry.id}`,
          sourceLabel: '통장 입금 내역',
          date: entry.date,
          amount: entry.amount,
          memo: [entry.description, entry.note].filter(Boolean).join(' · ')
        });
      }
    }
  }

  candidates.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(candidates);
});

// [추가] 프로젝트 탭 > 원가계산서: 직접원가/간접원가/일반관리비 세부 항목(원재료비, 외주
// 가공비, 간접노무비 등)을 통장 출금내역·카드사용내역에서 "자동 불러오기"로 채울 수
// 있도록, 특정 프로젝트(projectId)에 연결되고 원가 항목(costCategory)이 태그된 거래를
// 전부 찾아 후보로 돌려준다. 위 bank-withdrawal-candidates 등과 같은 패턴이지만,
// 프로젝트와 원가 항목이 둘 다 일치하는 거래만 추린다는 점이 다르다 - 태그는 있는데
// 프로젝트 연결이 없거나, 프로젝트는 연결됐는데 태그가 없는 거래는 후보에서 빠진다.
app.get('/api/admin-docs/project-cost-candidates', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const projectId = req.query.projectId as string;
  if (!projectId) return res.status(400).json({ error: 'projectId가 필요합니다.' });
  const dbData = getScopedData(req);

  const candidates: {
    sourceKey: string;
    sourceLabel: string;
    date: string;
    amount: number;
    category: string;
    memo?: string;
  }[] = [];

  for (const doc of (dbData.adminDocs || [])) {
    if (doc.category === 'bank_withdrawal' && doc.bankLedger) {
      for (const acc of (doc.bankLedger.accounts || [])) {
        for (const entry of (acc.entries || [])) {
          if (entry.projectId !== projectId || !entry.costCategory) continue;
          candidates.push({
            sourceKey: `bank_withdrawal_entry:${doc.id}:${entry.id}`,
            sourceLabel: '통장 출금 내역',
            date: entry.date,
            amount: Number(entry.amount) || 0,
            category: entry.costCategory,
            memo: [entry.description, entry.note].filter(Boolean).join(' · ')
          });
        }
      }
    }
    if (doc.category === 'card_usage' && doc.cardUsage) {
      for (const card of (doc.cardUsage.cards || [])) {
        for (const entry of (card.entries || [])) {
          if (entry.projectId !== projectId || !entry.costCategory) continue;
          candidates.push({
            sourceKey: `card_usage_entry:${doc.id}:${card.id}:${entry.id}`,
            sourceLabel: '카드사용내역',
            date: entry.date,
            amount: Number(entry.amount) || 0,
            category: entry.costCategory,
            memo: entry.note
          });
        }
      }
    }
  }

  candidates.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(candidates);
});

// [추가] 프로젝트 탭 > 손익계산서: 프로젝트별로 실제 입금(수입)과 지출(카드 사용 + 팔로우업
// 지출)을 자동으로 모아서 최종 수익금/수익률을 계산해준다. 수입은 회계관리 > 통장 입금
// 내역에서 projectId가 이 프로젝트로 연결된 항목의 합, 지출은 (1) 회계관리 > 법인카드 사용
// 내역에서 projectId가 연결된 항목의 합과 (2) 프로젝트 팔로우업에 이미 기록된 지출
// (expenses, 결제수단 무관 전체)의 합을 각각 별도 항목으로 보여준다 - 두 지출을 하나로
// 합치지 않고 분리해서 보여줘야, 법인카드로 결제한 같은 지출이 팔로우업과 카드 사용
// 내역 양쪽에 중복으로 기록됐는지 화면에서 바로 알아챌 수 있다. projectId가 연결되지
// 않은(자유 입력만 된) 입금/카드 사용 내역은 unmatchedIncome/unmatchedCardExpense로
// 총액만 따로 알려준다 - 회계 데이터가 프로젝트별 손익에 회사 전체 입출금 내역과 연동된,
// 회계관리 화면과 마찬가지로 관리자 전용 데이터이므로 requireAdmin으로 막는다.
app.get('/api/projects/pnl', (req, res) => {
  const requester = requireAdmin(req, res);
  if (!requester) return;
  const dbData = getScopedData(req);

  const incomeByProject: Record<string, number> = {};
  const cardExpenseByProject: Record<string, number> = {};
  // [추가] 프로젝트를 하나 골랐을 때 "총액"뿐 아니라 실제 입금/카드 사용 건 하나하나를
  // 보여줄 수 있도록, 프로젝트별로 건별 내역도 함께 모아둔다.
  const incomeEntriesByProject: Record<string, { date: string; amount: number; memo?: string }[]> = {};
  const cardExpenseEntriesByProject: Record<string, { date: string; amount: number; memo?: string; cardName?: string; holder?: string }[]> = {};
  let unmatchedIncome = 0;
  let unmatchedCardExpense = 0;

  for (const doc of (dbData.adminDocs || [])) {
    if (doc.category === 'bank_deposit' && doc.bankLedger) {
      for (const acc of (doc.bankLedger.accounts || [])) {
        for (const entry of (acc.entries || [])) {
          const amt = Number(entry.amount) || 0;
          if (entry.projectId) {
            incomeByProject[entry.projectId] = (incomeByProject[entry.projectId] || 0) + amt;
            (incomeEntriesByProject[entry.projectId] = incomeEntriesByProject[entry.projectId] || []).push({
              date: entry.date,
              amount: amt,
              memo: [entry.description, entry.note].filter(Boolean).join(' · ')
            });
          } else {
            unmatchedIncome += amt;
          }
        }
      }
    }
    if (doc.category === 'card_usage' && doc.cardUsage) {
      for (const card of (doc.cardUsage.cards || [])) {
        for (const entry of (card.entries || [])) {
          const amt = Number(entry.amount) || 0;
          if (entry.projectId) {
            cardExpenseByProject[entry.projectId] = (cardExpenseByProject[entry.projectId] || 0) + amt;
            (cardExpenseEntriesByProject[entry.projectId] = cardExpenseEntriesByProject[entry.projectId] || []).push({
              date: entry.date,
              amount: amt,
              memo: entry.note,
              cardName: card.cardName,
              holder: card.holder
            });
          } else {
            unmatchedCardExpense += amt;
          }
        }
      }
    }
  }

  const rows = (dbData.projects || []).map((p) => {
    const income = incomeByProject[p.id] || 0;
    const cardExpense = cardExpenseByProject[p.id] || 0;
    const followupExpense = (p.followUps || []).reduce((sum, fu) =>
      sum + (fu.expenses || []).reduce((s, ex) => s + (Number(ex.amount) || 0), 0), 0);
    const totalExpense = cardExpense + followupExpense;
    const profit = income - totalExpense;
    const profitMargin = income > 0 ? (profit / income) * 100 : null;
    const incomeEntries = (incomeEntriesByProject[p.id] || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const cardExpenseEntries = (cardExpenseEntriesByProject[p.id] || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return {
      projectId: p.id,
      projectName: p.name,
      status: p.status,
      income,
      cardExpense,
      followupExpense,
      totalExpense,
      profit,
      profitMargin,
      incomeEntries,
      cardExpenseEntries
    };
  });

  res.json({ rows, unmatchedIncome, unmatchedCardExpense });
});

// AI 업무일지 정제 (AI Polish) API
app.post('/api/worklogs/ai-polish', async (req, res) => {
  try {
    const { text, type, field } = req.body;
    if (!text) {
      return res.status(400).json({ error: '정제할 텍스트가 없습니다.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // API Key가 설정되지 않은 경우 스마트 정규식/프로그래밍 폴백 작동
      const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
      const polishedText = lines.map((line: string, i: number) => {
        let cleaned = line.replace(/^[-*•\d.\s]+/, '').trim();
        // 간단한 비즈니스 톤 접미사 보정
        if (!cleaned.endsWith('.') && !cleaned.endsWith('함') && !cleaned.endsWith('음') && !cleaned.endsWith('완료') && !cleaned.endsWith('수립')) {
          cleaned += ' 완료';
        }
        return `${i + 1}. ${cleaned}`;
      }).join('\n');
      
      return res.json({ polishedText });
    }

    const ai = new GoogleGenAI({ apiKey });
    const prompt = `
당신은 최고의 비즈니스 수석 비서 및 정밀한 업무 보고서 정리 전문가입니다.
사용자가 작성한 가공되지 않은 러프한(또는 어투가 캐주얼한) 업무 요약 내용을 읽고, 가공하여 격식 있고 깔끔하게 정돈된 기업형 업무 보고(개조식) 톤앤매너로 교정해주세요.

작성 대상 일지 타입: ${type === 'daily' ? '일일 업무일지' : '주간 업무일지'}
작성 대상 항목: ${field === 'tasksToday' || field === 'achievementsThisWeek' ? '실시 성과 및 달성 사항' : '향후 계획 및 예정 사항'}

[입력 데이터]:
"""
${text}
"""

[교정 원칙]:
1. 어휘를 격식 있고 전문적인 비즈니스 명사형/종결형 톤으로 변경해주세요 (예: '~함', '~했음', '~조율 완료', '~계획 수립', '~대응안 마련').
2. 내용을 구조화하여 가독성 높은 개조식 번호(1., 2., 3...)와 불렛 기호(-) 조합으로 일목요연하게 작성해주세요.
3. 원본 내용이 가지고 있는 핵심 의미, 구체적인 수치, 기관명, 담당자명 등을 왜곡하거나 임의로 빠뜨리지 마세요.
4. 불필요한 사족이나 미사여구, 인사말, 마크다운 백틱(\`\`\`json 또는 \`\`\` 등)은 모두 제거하고, 오직 "교정 정제된 완성 문장들"만 반환해야 합니다.
`;

    const response = await generateContentWithRetry(ai, {
      model: PRIMARY_GEMINI_MODEL,
      contents: prompt,
    });

    const polishedText = (response.text || '').trim();
    res.json({ polishedText });
  } catch (error: unknown) {
    console.error('AI Polish Error:', error);
    res.status(500).json({ error: toFriendlyAiErrorMessage(error) });
  }
});

// ------------------------------------------------------------------
// 📊 월별 세무 자료 자동 발송 — 더존 같은 회계 프로그램에 실시간으로 직접 연동하려면
// 별도의 기업 계약(EDI)이 필요해서 현실적으로 어렵다. 대신 "매달 세무사에게 서류를 직접
// 갖다주는 수고"라는 실제 문제를 해결하기 위해, 그 달의 모든 지출(차량비용/정비/미팅지출/
// 업무일지 지출)과 영수증 사진을 한데 모아 엑셀+영수증 압축파일로 만들어 이메일로 바로
// 발송한다. 세무사가 어떤 프로그램을 쓰든, 받은 엑셀/사진을 그대로 입력하면 된다.
// ------------------------------------------------------------------
app.post('/api/send-tax-package', async (req, res) => {
  try {
    const { year, month, accountantEmail } = req.body;
    if (!year || !month || !accountantEmail) {
      return res.status(400).json({ error: '연도, 월, 세무사 이메일을 모두 입력해주세요.' });
    }
    if (!isMailerConfigured) {
      return res.status(500).json({ error: '메일 발송 설정(BREVO_API_KEY)이 되어있지 않아 발송할 수 없습니다.' });
    }

    const dbData = getScopedData(req);
    const monthStr = String(month).padStart(2, '0');
    const prefix = `${year}-${monthStr}`; // 예: "2026-07"

    interface TaxRow {
      date: string; category: string; merchant: string; amount: number;
      payMethod: string; memo: string; receiptImage?: string;
    }
    const rows: TaxRow[] = [];

    const payMethodKo = (p?: string) => {
      if (p === 'personal_card') return '개인카드';
      if (p === 'cash' || p === 'cash_personal') return '현금';
      if (p === 'cash_company') return '현금(회사)';
      return '법인카드';
    };

    // 1) 차량 비용
    (dbData.expenses || []).forEach((e) => {
      if ((e.date || '').startsWith(prefix)) {
        rows.push({
          date: e.date, category: '차량비용', merchant: e.merchantName || e.categoryCustom || e.category || '',
          amount: e.amount || 0, payMethod: payMethodKo(e.payMethod), memo: e.memo || '', receiptImage: e.receiptImage
        });
      }
    });

    // 2) 차량 정비
    (dbData.maintenances || []).forEach((m) => {
      if ((m.date || '').startsWith(prefix)) {
        rows.push({
          date: m.date, category: '차량정비', merchant: m.shopName || m.title || '',
          amount: m.cost || 0, payMethod: payMethodKo(m.payMethod), memo: m.memo || '', receiptImage: m.receiptImage
        });
      }
    });

    // 3) 프로젝트 미팅 지출
    (dbData.projects || []).forEach((p) => {
      (p.followUps || []).forEach((fu) => {
        if ((fu.date || '').startsWith(prefix)) {
          (fu.expenses || []).forEach((exp) => {
            rows.push({
              date: fu.date, category: '미팅지출', merchant: exp.categoryCustom || exp.category || '',
              amount: exp.amount || 0, payMethod: payMethodKo(exp.payMethod),
              memo: [p.name, exp.memo].filter(Boolean).join(' · '), receiptImage: exp.receiptImage
            });
          });
        }
      });
    });

    // 4) 업무일지 지출 (일일)
    (dbData.dailyLogs || []).forEach((log) => {
      if ((log.date || '').startsWith(prefix)) {
        (log.expenses || []).forEach((exp) => {
          rows.push({
            date: log.date, category: '업무일지 지출', merchant: exp.categoryCustom || exp.category || '',
            amount: exp.amount || 0, payMethod: payMethodKo(exp.payMethod), memo: exp.memo || '', receiptImage: exp.receiptImage
          });
        });
      }
    });

    // 5) 업무일지 지출 (주간 - 시작일 기준)
    (dbData.weeklyLogs || []).forEach((log) => {
      if ((log.startDate || '').startsWith(prefix)) {
        (log.expenses || []).forEach((exp) => {
          rows.push({
            date: log.startDate, category: '업무일지 지출(주간)', merchant: exp.categoryCustom || exp.category || '',
            amount: exp.amount || 0, payMethod: payMethodKo(exp.payMethod), memo: exp.memo || '', receiptImage: exp.receiptImage
          });
        });
      }
    });

    rows.sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length === 0) {
      return res.status(400).json({ error: `${year}년 ${monthStr}월에 해당하는 지출 내역이 없습니다.` });
    }

    // 엑셀(.xlsx) 생성
    const wsData = [
      ['날짜', '구분', '상호/항목', '금액', '결제수단', '메모'],
      ...rows.map((r) => [r.date, r.category, r.merchant, r.amount, r.payMethod, r.memo])
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${year}년${monthStr}월`);
    const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    // 압축(.zip) 생성: 엑셀 + 영수증 사진 전부
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    const archiveFinished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
    });

    archive.append(excelBuffer, { name: `${year}년_${monthStr}월_지출내역.xlsx` });

    let receiptIndex = 1;
    for (const r of rows) {
      if (!r.receiptImage) continue;
      try {
        let imgBuffer: Buffer | null = null;
        let ext = 'jpg';
        if (r.receiptImage.startsWith('data:image/')) {
          const match = r.receiptImage.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            ext = match[1] === 'jpeg' ? 'jpg' : match[1];
            imgBuffer = Buffer.from(match[2], 'base64');
          }
        } else if (r.receiptImage.startsWith('http')) {
          const resp = await fetch(r.receiptImage);
          if (resp.ok) {
            imgBuffer = Buffer.from(await resp.arrayBuffer());
            const urlExt = r.receiptImage.split('?')[0].split('.').pop();
            if (urlExt && urlExt.length <= 4) ext = urlExt;
          }
        }
        if (imgBuffer) {
          const safeMerchant = (r.merchant || '').replace(/[^\w가-힣]/g, '').slice(0, 15);
          archive.append(imgBuffer, { name: `영수증/${receiptIndex}_${r.date}_${safeMerchant}.${ext}` });
          receiptIndex++;
        }
      } catch (err) {
        console.error('영수증 다운로드 실패(건너뜀):', err);
      }
    }

    archive.finalize();
    const zipBuffer = await archiveFinished;

    const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
    const companyName = dbData.myProfile?.company || '';

    await sendEmail({
      to: accountantEmail,
      subject: `[${year}년 ${monthStr}월] 지출 및 영수증 자료${companyName ? ' - ' + companyName : ''}`,
      html: `
        <div style="font-family: 'Malgun Gothic', sans-serif; padding: 24px; color:#111;">
          <h2 style="margin-bottom:8px;">${year}년 ${monthStr}월 지출 자료</h2>
          <p style="color:#555;">${companyName ? companyName + ' · ' : ''}총 ${rows.length}건, 합계 ${totalAmount.toLocaleString()}원</p>
          <p style="color:#555; margin-top:12px;">첨부된 압축파일 안에 <b>엑셀 정리표</b>와 <b>영수증 사진</b>이 모두 들어있습니다.</p>
        </div>
      `,
      attachments: [
        { filename: `${year}년_${monthStr}월_세무자료.zip`, content: zipBuffer }
      ]
    });

    res.json({ success: true, count: rows.length, totalAmount });
  } catch (err: unknown) {
    console.error('세무 자료 발송 오류:', err);
    res.status(500).json({ error: getErrorMessage(err) || '세무 자료 발송 중 오류가 발생했습니다.' });
  }
});

// [수정] Production: 동기 시작 (app.listen()을 즉시 호출해서 Health Check 통과)
// [수정] Development: 별도 비동기 함수 (Vite 서버 설정까지 기다렸다 시작)
function startServer() {
  // Production 환경: 정적 파일 제공 설정 (Vite 없음)
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
  }

  // [수정] 라우트 안에서 처리 안 하고 그냥 던져진(throw) 에러까지 Sentry가 잡아서 보고하도록.
  // 반드시 "모든 라우트 등록 이후, app.listen 이전"에 붙여야 한다.
  if (SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

  // ✅ 동기 호출: 즉시 포트에서 리스닝 시작
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 명함 관리 서버가 포트 ${PORT}번에서 성공적으로 가동되었습니다.`);
    console.log(`✅ 서버 시작 완료 - 동기 startup (app.listen 즉시 호출)`);
    console.log(`📌 DATABASE: ${process.env.DATABASE_URL ? '설정됨' : '미설정'}`);
    console.log(`🔒 SENTRY: ${SENTRY_DSN ? '활성화' : '비활성화'}`);
    console.log(`🌍 NODE_ENV: ${process.env.NODE_ENV}`);
  });

  // 백그라운드: bootstrapUsers 실행 (비동기, 비블로킹)
  // [수정] 타임아웃 30초: bootstrap이 너무 오래 걸리면 로그만 남기고 계속 진행
  // (서버 중단 없이, 나중에 필요하면 캐시가 자동으로 로드됨)
  (async () => {
    try {
      const bootstrapPromise = bootstrapUsers();
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve('TIMEOUT'), 30000)
      );
      const result = await Promise.race([bootstrapPromise, timeoutPromise]);

      if (result === 'TIMEOUT') {
        console.warn('⚠️ 사용자 부트스트랩이 30초 초과 - 백그라운드에서 계속 실행 중...');
        // 백그라운드에서 계속 실행되도록 놔둔다 (await 없이)
        bootstrapUsers().catch((err) => {
          console.error('❌ 백그라운드 부트스트랩 최종 실패:', err);
        });
      } else {
        console.log('✅ 사용자 부트스트랩 및 캐시 로드 완료');
      }
    } catch (err) {
      console.error('❌ 사용자 부트스트랩 실패 (서버는 계속 실행):', err);
      // 서버는 계속 실행된다 - 에러가 발생해도 프로세스 종료 안 함
    }
  })();
}

// [추가] Development 전용: Vite 서버 설정 (production에서는 호출 안 됨)
async function setupDevServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }
}

// Production: 동기 시작 (즉시)
startServer();

// Development: Vite 설정 (백그라운드)
if (process.env.NODE_ENV !== 'production') {
  setupDevServer().catch((err) => {
    console.error('❌ Vite 서버 설정 실패:', err);
  });
}
