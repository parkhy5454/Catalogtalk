
# FlipBook SaaS MVP - 0원 스택

GitHub + Vercel + Supabase 조합, 월 0원 운영

## 스택 요금 비교
- Vercel Hobby: $0 (100GB 대역폭)
- Supabase Free: $0 (DB 0.5GB + 파일 1GB + 대역폭 50GB)
- 합계: $0 (고객 50곳까지)

고객 200곳 이상: Neon ($19) + R2 ($1.5) + Vercel ($0) = 월 $20

## 설치
1. supabase/schema.sql 을 Supabase SQL Editor에 붙여넣기
2. Storage > flipbook-files 버킷 Public 생성
3. .env.local 생성 (env.example 참고)
4. npm install && npm run dev
5. GitHub 푸시 -> Vercel 자동 배포

## 구조
- / : 랜딩 (요금제 비교 포함)
- /dashboard : PDF 업로드 + 링크 생성 (Supabase 연동)
- /b/[slug] : 고객이 보는 플립북 뷰어 (iBooks 스타일 동그란 말림 + 소리)
- /public/sample-flipbook.html : 당신이 만든 CoolAutomation_iBooks_Round_Flipbook.html 넣는 곳

## 다음 단계 (돈 벌기 시작하면)
- Supabase Storage -> Cloudflare R2로 이전 (대역폭 무료)
- Supabase DB -> Neon으로 이전 (Vercel이랑 더 빠름)
- 조회수 추적 + 리드 수집 기능 추가
