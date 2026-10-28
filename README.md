# 카탈로그톡 - Production Ready

PDF를 카톡에서 바로 보는 플립북 링크 서비스 (모바일 최적화 버전)

## Tech Stack
- Next.js 14 (App Router, TypeScript)
- Supabase (Auth, Postgres + RLS, Storage)
- pdf.js 3.11.174 (브라우저에서 PDF → WebP 페이지 이미지 변환)
- Vercel (Hosting)

## 주요 기능
- PDF 업로드 → 페이지별 WebP 이미지 + JPEG 썸네일 자동 생성 (업로더 브라우저에서 변환)
- 플립북 뷰어 `/b/[slug]`: [page-flip](https://github.com/Nodlik/StPageFlip) 기반 말림(curl) 넘김, 드래그/스와이프, 키보드 화살표
- 넘김 소리: Web Audio로 합성한 종이 넘기는 소리 (끄기/켜기 버튼, 설정은 브라우저에 저장)
- 확대 보기: "확대" 버튼으로 현재 페이지를 전체 화면에서 두 손가락 핀치 줌, 두 번 탭
- 태블릿/데스크톱(768px 이상)은 두 쪽 펼침 보기 + 썸네일 목록
- 대시보드에서 카탈로그 삭제 (DB 행과 스토리지 파일을 함께 정리)
- 카톡/SNS 미리보기: 서버에서 OpenGraph 태그(`og:title`, `og:description`, `og:image`, `og:url`) 생성
- 조회수(원자적 증가) + 페이지별 체류 시간 기록
- 요금제별 플립북 개수 제한 (무료 3개, Starter 20개, Pro/Team 무제한) — DB 트리거로 강제

## 반응형 기준
| 구분 | 폭 |
|---|---|
| 모바일 (기본) | 320px ~ 767px (320 / 375 기준 점검) |
| 태블릿 | 768px 이상 |
| 데스크톱 | 1200px 이상 |

- 모든 페이지에 `viewport` 메타 적용 (`app/layout.tsx`, `interactive-widget=resizes-content`로 키보드가 올라와도 입력창이 가려지지 않음)
- 버튼 최소 높이 48px, 버튼 간격 8px 이상, 호버 대신 `:active` 피드백

## Setup

1. Supabase 프로젝트 생성 (Seoul region)
2. **SQL Editor에서 `supabase/schema.sql` 전체 실행.** 기존 v1 DB에서도 그대로 실행 가능합니다 (idempotent).
   - RLS 정책, `get_flipbook()`, `increment_view()`, 가입 시 customers 생성 트리거, 요금제 제한 트리거가 포함됩니다.
   - **배포 전에 먼저 실행하세요.** 새 코드는 RLS가 켜진 상태를 전제로 합니다.
3. Storage에서 `flipbook-files` 버킷을 **Public**으로 생성
4. Authentication → Providers → Email 활성화
5. `.env.example`을 `.env.local`로 복사하고 값 입력
6. Vercel에 GitHub 연동 후 Environment Variables 설정:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Publishable key)
   - `SUPABASE_SERVICE_ROLE_KEY` (관리자 페이지용, 서버에서만 사용)
   - `NEXT_PUBLIC_SITE_URL` (예: `https://catalogtalk.kr`)
7. 도메인: catalogtalk.kr → Vercel Domains에서 추가

## 기존 카탈로그
v2 이전에 만든 카탈로그는 모바일 뷰어용 이미지가 없습니다. 대시보드에서 **"뷰어 변환"** 버튼을 누르면 원본 PDF로 이미지를 다시 만듭니다.

## 로컬 개발
```bash
npm install
npm run dev
```
`npm run build`는 환경변수가 없어도 빌드되지만, 실제 동작은 Supabase 값이 있어야 합니다.

## 알려진 한계 (MVP)
- 휴대폰 세로 모드에서 왼쪽으로 미는 넘김은 뷰어가 보조로 처리합니다(라이브러리의 세로 모드 방향 판정 우회).
- 확대는 드래그 넘김과 분리된 전체 화면 보기로 제공합니다. 책 위에서 직접 핀치 줌은 지원하지 않습니다.
- IP 주소는 클라이언트에서 수집할 수 없어 기록하지 않습니다 (user agent, 페이지 번호, 체류 시간만 기록).
- 저장 용량(무료 100MB 등)은 아직 강제하지 않습니다. 플립북 개수 제한만 강제합니다.
- 플립북 이름 변경 기능은 아직 없습니다.
- 샘플 PDF 기준 변환 시간은 페이지 수와 기기 성능에 따라 다릅니다. 대량 페이지는 데스크톱 업로드를 권장합니다.

## Deployment
- `main` push → Vercel 자동 배포. **운영 반영 전 스키마 SQL 실행 여부를 먼저 확인하세요.**
