import React, { useState, useRef } from 'react';
import { X, Upload, ScanLine, CheckCircle2, Sparkles, DollarSign, Calendar, Landmark, Tag, FileText, Camera } from 'lucide-react';
import { formatCurrencyInput, parseCurrencyInput } from '../currencyFormat.js';
import { getTodayLocalStr } from '../dateUtils.js';
import { LiveCameraCapture } from './LiveCameraCapture.js';
import { CropAdjustModal, warpDataUrlWithNormalizedCorners, isValidNormalizedCorners, resizeDataUrl } from './CropAdjustModal.js';

import { getErrorMessage } from '../errorUtils.js';
// [추가] 해외 출장 경비(AdminDocsView) 화면의 "사용구분"/"지급방법" 값 체계를 그대로 따른다.
// AdminDocsView.tsx의 OVERSEAS_TRIP_CATEGORY_PRESETS/OVERSEAS_TRIP_PAY_METHOD_PRESETS와 반드시
// 같은 값 목록이어야 한다 - AdminDocsView가 이 모달을 가져다 쓰는 쪽이라 그 반대 방향으로
// import하면 순환 참조가 생기므로, 이 작은 고정 목록만 여기 별도로 둔다.
const OVERSEAS_TRIP_CATEGORY_OPTIONS = ['항공료', '숙박비', '식비', '교통비', '환전 비용', '직원 선물', '기타'];
const OVERSEAS_TRIP_PAY_METHOD_OPTIONS = ['신용카드', '현금'];

interface Props {
  expenseType: 'vehicle' | 'worklog' | 'overseas_trip';
  onClose: () => void;
  onScanComplete: (data: {
    amount: number;
    date: string;
    merchantName: string;
    memo: string;
    category: string;
    payMethod: string;
    receiptImage: string;
  }) => void;
}

export const ReceiptScanModal: React.FC<Props> = ({ expenseType, onClose, onScanComplete }) => {
  const [receiptImg, setReceiptImg] = useState<string>('');
  // [수정] 영수증 미리보기를 눌렀을 때 전체화면으로 크게 볼 수 있는 팝업(라이트박스)용 상태
  const [isReceiptEnlarged, setIsReceiptEnlarged] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanDone, setScanDone] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isCameraOpen, setIsCameraOpen] = useState<boolean>(false);
  const [cropRawImage, setCropRawImage] = useState<string | null>(null);

  // 파싱 결과 상태
  const [form, setForm] = useState({
    amount: 0,
    date: getTodayLocalStr(),
    merchantName: '',
    memo: '',
    category: '',
    payMethod: ''
  });

  const handleFile = (file: File) => {
    if (!file || !file.type.startsWith('image/')) {
      alert('이미지 파일만 업로드할 수 있습니다.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setCropRawImage(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleStartOCR = async (imageOverride?: string) => {
    const targetImage = imageOverride || receiptImg;
    if (!targetImage) {
      alert('스캔할 영수증 이미지를 업로드해주세요.');
      return;
    }

    setIsScanning(true);
    setScanDone(false);

    try {
      // [추가] 휴대폰 원본 사진은 용량이 커서 전송이 느리고 5MB 제한에 걸리기 쉬우므로, 글자가 읽힐 만큼만 줄여서 보낸다.
      let payloadImage = targetImage;
      try {
        payloadImage = await resizeDataUrl(targetImage, 1600, 0.85);
      } catch (resizeErr) {
        console.error('영수증 축소 실패, 원본으로 전송:', resizeErr);
      }
      const res = await fetch('/api/scan-receipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // [추가] 해외 출장 경비 화면은 서버의 분류 체계(영문 코드)가 아니라 이 화면이 실제로
        // 쓰는 한글 사용구분/지급방법 값(항공료/숙박비/.../신용카드/현금)으로 바로 분류받기
        // 위해 context를 같이 넘긴다 (server.ts의 /api/scan-receipt 참고).
        body: JSON.stringify({ image: payloadImage, context: expenseType === 'overseas_trip' ? 'overseas_trip' : undefined })
      });
      const data = await res.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // 컨텍스트(차량비용 vs 업무일지비용 vs 해외출장경비)에 따른 카테고리 매핑
      let mappedCategory = data.category || 'other';
      if (expenseType === 'overseas_trip') {
        // 서버가 이미 이 화면의 한글 사용구분 값을 그대로 돌려주므로, 알려진 값이면 그대로
        // 쓰고 아니면(인식 실패 등) "기타"로 안전하게 기본값을 둔다.
        mappedCategory = OVERSEAS_TRIP_CATEGORY_OPTIONS.includes(data.category) ? data.category : '기타';
      } else if (expenseType === 'worklog') {
        if (data.category === 'meal') {
          mappedCategory = 'lunch'; // 기본값으로 점심식사 매핑
        } else if (data.category === 'beverage') {
          mappedCategory = 'drinks';
        } else if (data.category === 'supplies') {
          mappedCategory = 'purchase';
        } else if (data.category === 'agency_drive') {
          mappedCategory = 'proxy';
        } else if (!['lunch', 'dinner', 'breakfast', 'drinks', 'fuel', 'parking', 'proxy', 'purchase', 'custom'].includes(data.category)) {
          mappedCategory = 'custom';
        }
      } else {
        // 차량 비용의 경우
        if (data.category === 'breakfast' || data.category === 'lunch' || data.category === 'dinner') {
          mappedCategory = 'meal';
        } else if (data.category === 'drinks') {
          mappedCategory = 'beverage';
        } else if (data.category === 'purchase') {
          mappedCategory = 'supplies';
        } else if (data.category === 'proxy') {
          mappedCategory = 'agency_drive';
        } else if (!['fuel', 'toll', 'parking', 'maintenance', 'tax_insurance', 'other', 'agency_drive', 'beverage', 'meal', 'supplies', 'custom'].includes(data.category)) {
          mappedCategory = 'other';
        }
      }

      // 결제수단 매핑
      let mappedPayMethod = data.payMethod || 'company_card';
      if (expenseType === 'overseas_trip') {
        mappedPayMethod = OVERSEAS_TRIP_PAY_METHOD_OPTIONS.includes(data.payMethod) ? data.payMethod : '신용카드';
      } else if (expenseType === 'worklog') {
        if (data.payMethod === 'company_card') mappedPayMethod = 'company_card';
        else if (data.payMethod === 'personal_card') mappedPayMethod = 'personal_card';
        else if (data.payMethod === 'cash') mappedPayMethod = 'cash_company'; // 기본값으로 법인현금 매핑
      } else {
        if (!['company_card', 'personal_card', 'cash'].includes(data.payMethod)) {
          mappedPayMethod = 'company_card';
        }
      }

      // [추가] 금액을 못 읽었거나 문자 인식 대체 결과이면 사용자가 꼭 확인하도록 알려준다 (저장은 금액 입력 후에만 가능).
      if (data.ocrFallback) {
        alert('AI 인식이 어려워 문자 인식 결과로 채웠습니다. 금액과 날짜를 꼭 확인해 주세요.');
      } else if (!Number(data.amount)) {
        alert('금액을 읽지 못했습니다. 금액을 직접 입력해 주세요.');
      }

      setForm({
        amount: Number(data.amount) || 0,
        date: data.date || getTodayLocalStr(),
        merchantName: data.merchantName || '',
        memo: data.memo || '',
        category: mappedCategory,
        payMethod: mappedPayMethod
      });

      // [수정] AI가 함께 알려준 "영수증 실물의 네 꼭짓점 좌표"로 사진을 다시 한번 정밀하게 잘라낸다.
      if (isValidNormalizedCorners(data.corners)) {
        try {
          const recropped = await warpDataUrlWithNormalizedCorners(targetImage, data.corners);
          setReceiptImg(recropped);
        } catch (err) {
          console.error('AI 좌표 기반 영수증 재크롭 실패, 기존 사진 유지:', err);
        }
      }

      setScanDone(true);
    } catch (err: unknown) {
      alert(getErrorMessage(err) || '스캔 중 오류 발생');
    } finally {
      setIsScanning(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.amount) {
      alert('금액을 확인해주세요.');
      return;
    }

    onScanComplete({
      amount: form.amount,
      date: form.date,
      merchantName: form.merchantName,
      memo: form.memo,
      category: form.category,
      payMethod: form.payMethod,
      receiptImage: receiptImg
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative w-full max-w-4xl bg-white border border-slate-200 rounded-3xl shadow-2xl flex flex-col md:flex-row overflow-y-auto md:overflow-hidden max-h-[95vh] md:max-h-[92vh]">
        
        {/* 좌측: 영수증 업로드 및 스캔 버튼 */}
        <div className="w-full md:w-1/2 bg-slate-50 p-6 flex flex-col justify-between border-b md:border-b-0 md:border-r border-slate-200 md:overflow-y-auto">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <ScanLine className="w-5 h-5 text-indigo-400 animate-pulse" />
                <h3 className="font-bold text-base text-slate-900">영수증 이미지 스캔</h3>
              </div>
              <span className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-500/30 px-2 py-0.5 rounded font-sans">Gemini Vision OCR</span>
            </div>

            {/* 드래그 앤 드롭 영역 */}
            <div 
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`aspect-[3/4] w-full rounded-2xl border-2 border-dashed flex flex-col items-center justify-center relative overflow-hidden transition-all duration-200 group ${
                receiptImg 
                  ? 'border-slate-200 bg-slate-100' 
                  : isDragOver
                  ? 'border-indigo-500 bg-indigo-500/10 scale-[0.98]'
                  : 'border-slate-200 bg-slate-100'
              }`}
            >
              {receiptImg ? (
                <>
                  <img
                    src={receiptImg}
                    alt="영수증 미리보기"
                    onClick={() => setIsReceiptEnlarged(true)}
                    className="w-full h-full object-contain p-2 cursor-pointer"
                  />
                  <div className="absolute inset-0 bg-slate-50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                    <button 
                      type="button" 
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white transition-all shadow-md"
                    >
                      변경
                    </button>
                    <button 
                      type="button" 
                      onClick={(e) => {
                        e.stopPropagation();
                        setReceiptImg('');
                        setScanDone(false);
                      }} 
                      className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-bold text-white transition-all shadow-md"
                    >
                      삭제
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center text-center p-6 gap-3">
                  <Upload className="w-10 h-10 text-slate-400 mb-1" />
                  <button
                    type="button"
                    onClick={() => setIsCameraOpen(true)}
                    className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold shadow-lg shadow-indigo-600/25 transition-all"
                  >
                    <Camera className="w-4 h-4" />
                    카메라로 촬영 (가이드 자동맞춤)
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-slate-400 hover:text-slate-600 underline underline-offset-2"
                  >
                    갤러리에서 사진 선택 / 드래그
                  </button>
                </div>
              )}
              <input 
                ref={fileInputRef}
                type="file" 
                accept="image/*" 
                onChange={handleImageChange} 
                className="hidden" 
              />
            </div>
          </div>

          <div className="pt-6">
            <button
              type="button"
              disabled={isScanning || !receiptImg}
              onClick={handleStartOCR}
              className={`w-full py-3.5 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 shadow-xl transition-all ${
                isScanning
                  ? 'bg-slate-100 text-slate-500 cursor-wait'
                  : !receiptImg
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-500 hover:from-indigo-500 hover:to-violet-500 text-slate-700 shadow-indigo-600/20 active:scale-95'
              }`}
            >
              {isScanning ? (
                <>
                  <div className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                  <span>AI가 영수증 정보를 판독하고 있습니다...</span>
                </>
              ) : scanDone ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  <span>스캔 완료! 다시 판독하기</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5 text-amber-600" />
                  <span>AI 영수증 자동 인식 가동</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 우측: 인식 결과 확인 및 편집 폼 */}
        <form onSubmit={handleSubmit} className="w-full md:w-1/2 p-6 flex flex-col justify-between md:overflow-y-auto">
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 mb-4">
              <h3 className="font-bold text-lg text-slate-900">지출 내역 자동 완성</h3>
              <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-700 p-1 bg-slate-100 rounded-full">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-sm pr-1">
              <div>
                <label className="text-xs text-slate-500 block mb-1 font-medium">지출 금액 (원) *</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-slate-500 font-bold">₩</span>
                  <input 
                    type="text" 
                    inputMode="numeric"
                    required 
                    placeholder="0" 
                    value={form.amount ? formatCurrencyInput(form.amount) : ''} 
                    onChange={(e) => setForm({ ...form, amount: parseCurrencyInput(e.target.value) })} 
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-4 py-2.5 text-slate-700 font-bold text-base focus:outline-none focus:border-indigo-500" 
                  />
                </div>
              </div>

              {/* [수정] 모바일(특히 아이폰)에서 "지출 일자" 원어 date 입력창이 자기 칸보다
              넓게 렌더링되면서 옆의 "결제 수단" 드롭다운과 겹쳐 보이는 문제가 있었다. CSS 그리드
              항목은 기본적으로 min-width:auto라서, 안의 콘텐츠(네이티브 date 인풋)가 칸보다
              넓으면 줄어들지 않고 옆 칸을 침범한다. 각 칸과 입력창에 min-w-0을 줘서 그리드
              트랙 너비에 맞게 확실히 줄어들도록 고쳤다. */}
              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <label className="text-xs text-slate-500 block mb-1 font-medium">지출 일자</label>
                  <div className="relative min-w-0">
                    <input
                      type="date"
                      required
                      value={form.date}
                      onChange={(e) => setForm({ ...form, date: e.target.value })}
                      className="w-full min-w-0 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div className="min-w-0">
                  <label className="text-xs text-slate-500 block mb-1 font-medium">결제 수단</label>
                  <select
                    value={form.payMethod}
                    onChange={(e) => setForm({ ...form, payMethod: e.target.value })}
                    className="w-full min-w-0 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-none focus:border-indigo-500"
                  >
                    {expenseType === 'overseas_trip' ? (
                      OVERSEAS_TRIP_PAY_METHOD_OPTIONS.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))
                    ) : expenseType === 'worklog' ? (
                      <>
                        <option value="company_card">법인카드</option>
                        <option value="personal_card">개인카드</option>
                        <option value="cash_company">법인현금</option>
                        <option value="cash_personal">개인현금</option>
                      </>
                    ) : (
                      <>
                        <option value="company_card">법인카드</option>
                        <option value="personal_card">개인카드</option>
                        <option value="cash">현금</option>
                      </>
                    )}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <label className="text-xs text-slate-500 block mb-1 font-medium">상호명</label>
                  <input
                    type="text"
                    placeholder="예: 스타벅스 강남점"
                    value={form.merchantName}
                    onChange={(e) => setForm({ ...form, merchantName: e.target.value })}
                    className="w-full min-w-0 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="min-w-0">
                  <label className="text-xs text-slate-500 block mb-1 font-medium">카테고리</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="w-full min-w-0 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-slate-700 focus:outline-none focus:border-indigo-500"
                  >
                    {expenseType === 'overseas_trip' ? (
                      OVERSEAS_TRIP_CATEGORY_OPTIONS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))
                    ) : expenseType === 'worklog' ? (
                      <>
                        <option value="lunch">점심식사</option>
                        <option value="dinner">저녁식사</option>
                        <option value="breakfast">아침식사</option>
                        <option value="drinks">음료&커피</option>
                        <option value="fuel">주유비</option>
                        <option value="parking">주차비</option>
                        <option value="proxy">대리운전비</option>
                        <option value="purchase">물품구입</option>
                        <option value="custom">직접입력</option>
                      </>
                    ) : (
                      <>
                        <option value="fuel">주유비</option>
                        <option value="toll">통행료</option>
                        <option value="parking">주차비</option>
                        <option value="maintenance">차량 정비비</option>
                        <option value="tax_insurance">세금/보험료</option>
                        <option value="beverage">음료&커피</option>
                        <option value="meal">식대</option>
                        <option value="supplies">물품 구입비</option>
                        <option value="agency_drive">대리운전비</option>
                        <option value="other">기타</option>
                        <option value="custom">직접입력</option>
                      </>
                    )}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-500 block mb-1 font-medium">품목 / 메모</label>
                <textarea 
                  rows={3} 
                  placeholder="예: 업무미팅 음료 및 식사 결제" 
                  value={form.memo} 
                  onChange={(e) => setForm({ ...form, memo: e.target.value })} 
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-3 text-slate-700 focus:outline-none focus:border-indigo-500" 
                />
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-slate-200 flex gap-3">
            <button 
              type="button" 
              onClick={onClose} 
              className="w-1/3 py-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-sm"
            >
              취소
            </button>
            <button 
              type="submit" 
              className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-lg shadow-emerald-600/30"
            >
              내역 적용 및 등록
            </button>
          </div>
        </form>

      </div>

      {isCameraOpen && (
        <LiveCameraCapture
          title="영수증 촬영"
          docLabel="영수증"
          guideAspectRatio={0.62}
          onCapture={(dataUrl) => {
            setReceiptImg(dataUrl);
            setIsCameraOpen(false);
            handleStartOCR(dataUrl);
          }}
          onCancel={() => setIsCameraOpen(false)}
          onFallbackToFile={() => {
            setIsCameraOpen(false);
            fileInputRef.current?.click();
          }}
        />
      )}

      {cropRawImage && (
        <CropAdjustModal
          imageDataUrl={cropRawImage}
          title="영수증 테두리 확인"
          documentType="receipt"
          onConfirm={(cropped) => {
            setReceiptImg(cropped);
            setScanDone(false);
            setCropRawImage(null);
            // [수정] 카메라 자동촬영과 마찬가지로, 테두리를 수동으로 맞춘 뒤(갤러리 업로드 등)에도
            // 바로 AI 인식이 자동으로 시작되도록 통일한다.
            handleStartOCR(cropped);
          }}
          onCancel={() => setCropRawImage(null)}
        />
      )}

      {/* [수정] 영수증 미리보기 확대보기 라이트박스 - 닫기 버튼이 휴대폰 상태바(배터리 등)와
      겹쳐 안 눌리는 문제가 있어, env(safe-area-inset-top)만큼 아래로 내려서 배치한다. */}
      {isReceiptEnlarged && receiptImg && (
        <div
          className="fixed inset-0 bg-slate-900/85 backdrop-blur-md z-[110] flex items-center justify-center p-4"
          onClick={() => setIsReceiptEnlarged(false)}
        >
          <button
            onClick={() => setIsReceiptEnlarged(false)}
            className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold border border-slate-200 transition-all"
          >
            닫기
          </button>
          <img
            src={receiptImg}
            alt="영수증 확대보기"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-[85vh] object-contain rounded-xl shadow-2xl border border-slate-200"
          />
        </div>
      )}
    </div>
  );
};
