# 카탈로그톡 - Production Ready

PDF를 카톡에서 바로 보는 플립북 링크 서비스

## Tech Stack
- Next.js 14 (App Router, TypeScript)
- Supabase (Auth, DB, Storage)
- Vercel (Hosting)

## Setup

1. Supabase 프로젝트 생성 (Seoul region)
2. SQL Editor에서 supabase/schema.sql 실행 -> Run without RLS
3. Storage에서 flipbook-files 버킷을 Public으로 생성
4. Authentication -> Providers -> Email 활성화
5. .env.example을 .env.local로 복사하고 키 입력
6. Vercel에 GitHub 연동, Environment Variables 설정:
   - NEXT_PUBLIC_SUPABASE_URL
   - NEXT_PUBLIC_SUPABASE_ANON_KEY (Publishable key)

## Deployment
- GitHub push -> Vercel 자동 배포
- 도메인: catalogtalk.kr -> Vercel Domains에서 추가

## Cost
- Free tier: Vercel Hobby 0원 + Supabase Free 0원 (고객 50곳까지)
- Scale: Cloudflare R2 + Neon (월 $7~20)