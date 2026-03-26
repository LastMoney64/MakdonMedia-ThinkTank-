---
description: 전체 자동화 파이프라인 실행. 블로그 → 인스타 → 쇼츠 순차 처리. "자동화", "파이프라인" 키워드에 반응.
---

# 자동화 파이프라인 실행

전체 콘텐츠 자동화 파이프라인을 순차적으로 실행한다.

## 파이프라인 흐름
```
[Blog Publisher] → [Social Distributor] → [Media Producer]
    블로그 작성        인스타 카드/릴스       YouTube Shorts
    ↓                  ↓                     ↓
  Blogger 발행      Instagram 포스팅      YouTube 업로드
```

## 실행 순서

### Phase 1: Blog Publisher
1. Vibe Coding 최신 트렌드 리서치
2. 주제 선정 + SEO 키워드 분석
3. 블로그 포스트 작성 + 품질 검수
4. Google Blogger 발행
5. **출력물을 Phase 2로 전달**

### Phase 2: Social Distributor
1. 블로그 포스트 수신
2. 인스타 카드 5-7장 생성
3. 릴스 스크립트 작성
4. 캡션 + 해시태그 생성
5. Instagram 포스팅
6. **이미지 + 스크립트를 Phase 3로 전달**

### Phase 3: Media Producer
1. 인스타 이미지 수신
2. Google TTS 나레이션 생성
3. 이미지 + TTS + 자막 조합
4. YouTube Shorts 영상 생성
5. YouTube 업로드

## 스케줄 (하루 2회)
- **오전 9:00 KST** — 모닝 포스트 (뉴스/트렌드)
- **오후 6:00 KST** — 이브닝 포스트 (교육/실전)

## 모니터링
- 각 Phase 완료 시 활동 로그에 기록
- 실패 시 해당 Phase 재시도 (최대 2회)
- 전체 결과를 리포트로 요약
