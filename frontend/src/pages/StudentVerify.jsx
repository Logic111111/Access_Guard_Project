import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { Camera, Upload, Check, Eye } from "lucide-react";
import { toast } from "sonner";
import * as faceapi from "face-api.js";
import Tesseract from "tesseract.js";

const FACE_MODELS_URL = "https://justadudewhohacks.github.io/face-api.js/models";
let modelsReady = null;
async function loadFaceModels() {
  if (modelsReady) return modelsReady;
  modelsReady = (async () => {
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
      await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
      await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
      return true;
    } catch (e) {
      console.warn("face-api models failed to load", e);
      return false;
    }
  })();
  return modelsReady;
}

async function descriptorFromDataUrl(dataUrl) {
  const img = await faceapi.fetchImage(dataUrl);
  const det = await faceapi
    .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  return det?.descriptor || null;
}

const STEPS = ["ID Front", "ID Back", "Selfie", "Liveness", "Match Check"];

export default function StudentVerify() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [idFront, setIdFront] = useState(null);
  const [idBack, setIdBack] = useState(null);
  const [selfie, setSelfie] = useState(null);
  const [blinks, setBlinks] = useState(0);
  const [liveLoading, setLiveLoading] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [matchScore, setMatchScore] = useState(null);
  const [matching, setMatching] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [extractedName, setExtractedName] = useState("");
  const [extractedFace, setExtractedFace] = useState(null);
  const [ocrLoading, setOcrLoading] = useState(false);

  const sessionData = JSON.parse(sessionStorage.getItem("ag_join_session") || "{}");
  const studentData = JSON.parse(sessionStorage.getItem("ag_join_student") || "{}");

  useEffect(() => {
    loadFaceModels();
    if (step >= 2 && step <= 3 && !streaming) startCamera();
    if ((step === 2 || step === 3) && streamRef.current && videoRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(e => console.warn(e));
    }
    if (step === 4 && matchScore == null && idFront && selfie && !matching) {
      runMatch();
    }
    return () => { if (step !== 2 && step !== 3) stopCamera(); };
    // eslint-disable-next-line
  }, [step]);

  const startCamera = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("getUserMedia not supported or insecure context");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStreaming(true);
      setCameraFailed(false);
    } catch (e) {
      setCameraFailed(true);
      toast.error("Live camera unavailable. Switched to secure photo upload mode.");
    }
  };
  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    const v = videoRef.current;
    if (v?.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
    setStreaming(false);
  };

  const captureFromCamera = () => {
    const c = canvasRef.current; const v = videoRef.current;
    if (!c || !v) return null;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d").drawImage(v, 0, 0);
    return c.toDataURL("image/jpeg", 0.7);
  };

  const handleFile = (setter, isFrontID = false) => (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      setter(r.result);
      if (isFrontID) {
        setOcrLoading(true);
        try {
          const { data: { text } } = await Tesseract.recognize(r.result, 'eng');
          setExtractedName(text);
          await loadFaceModels();
          const img = await faceapi.fetchImage(r.result);
          const det = await faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }));
          if (det) {
            const canvas = document.createElement("canvas");
            const box = det.box;
            const pad = 20;
            canvas.width = box.width + pad * 2; canvas.height = box.height + pad * 2;
            canvas.getContext("2d").drawImage(img, box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2, 0, 0, canvas.width, canvas.height);
            setExtractedFace(canvas.toDataURL("image/jpeg"));
          }
        } catch (err) {
          console.warn("Extraction failed", err);
        } finally {
          setOcrLoading(false);
        }
      }
    };
    r.readAsDataURL(f);
  };

  const getEAR = (eye) => {
    const dist = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const v1 = dist(eye[1], eye[5]);
    const v2 = dist(eye[2], eye[4]);
    const h = dist(eye[0], eye[3]);
    return (v1 + v2) / (2.0 * h);
  };

  // Robust blink detection via Eye Aspect Ratio (EAR) using face landmarks
  const startLiveness = async () => {
    setLiveLoading(true); setBlinks(0);
    const v = videoRef.current;
    if (!v) return;
    await loadFaceModels();

    let frames = 0;
    let blinkCount = 0;
    let isBlinking = false;

    const interval = setInterval(async () => {
      if (frames >= 60) { // ~6 seconds
        clearInterval(interval);
        setLiveLoading(false);
        setBlinks(blinkCount);
        if (blinkCount >= 2) {
          const photo = captureFromCamera();
          setSelfie(prev => prev || photo);
          toast.success(`Liveness OK — ${blinkCount} blinks detected`);
          setStep(4);
        } else {
          toast.error("Liveness failed — please blink naturally and retry");
        }
        return;
      }

      frames += 1;
      try {
        const det = await faceapi.detectSingleFace(v, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 })).withFaceLandmarks();
        if (det) {
          const leftEye = det.landmarks.getLeftEye();
          const rightEye = det.landmarks.getRightEye();
          const leftEAR = getEAR(leftEye);
          const rightEAR = getEAR(rightEye);
          const avgEAR = (leftEAR + rightEAR) / 2.0;

          if (avgEAR < 0.25) {
            isBlinking = true;
          } else {
            if (isBlinking) {
              blinkCount += 1;
              setBlinks(blinkCount);
              isBlinking = false;
            }
          }
        }
      } catch (err) {
        // ignore occasional frame processing errors
      }
    }, 100);
  };

  const runMatch = async () => {
    setMatching(true); setMatchScore(null);
    try {
      const ok = await loadFaceModels();
      if (!ok) { toast.error("Face models unavailable — proceeding for invigilator review"); setMatchScore(0.5); return; }
      const [idDesc, selfieDesc] = await Promise.all([
        descriptorFromDataUrl(idFront),
        descriptorFromDataUrl(selfie),
      ]);
      if (!idDesc) { toast.error("No face detected in your ID photo. Please retake."); setMatchScore(0); return; }
      if (!selfieDesc) { toast.error("No face detected in selfie. Please retake."); setMatchScore(0); return; }
      const dist = faceapi.euclideanDistance(idDesc, selfieDesc);
      // threshold 0.6 = same person; we map dist [0..0.8] to [1..0]
      const s = Math.max(0, Math.min(1, 1 - dist / 0.8));
      setMatchScore(s);
      if (s >= 0.45) toast.success(`Match ${(s * 100).toFixed(0)}% — verified`);
      else toast.error(`Match too low (${(s * 100).toFixed(0)}%). Please retake selfie.`);
    } catch (e) {
      console.warn(e);
      setMatchScore(0.5);
    } finally { setMatching(false); }
  };

  const submit = async () => {
    setSubmitting(true);
    const score = matchScore ?? 0.0;
    if (score < 0.50) {
      toast.warning("Your face match score is under 50%. Your submission will require manual review by the invigilator.");
    }
    try {
      const { data } = await api.post("/public/candidates/join", {
        session_code: sessionData.session_code,
        student_id: studentData.student_id,
        full_name: studentData.full_name,
        id_front_b64: idFront,
        id_back_b64: idBack,
        selfie_b64: selfie,
        liveness_passed: blinks >= 2 || blinks === -1,
        face_match_score: Number(score.toFixed(3)),
      });
      sessionStorage.setItem("ag_candidate_id", data.id);
      if (data.candidate_token) sessionStorage.setItem("ag_candidate_token", data.candidate_token);
      sessionStorage.setItem("ag_face_match", String(score));
      toast.success("Joined! Awaiting invigilator approval.");
      nav("/student/exam");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Submission failed");
    } finally { setSubmitting(false); }
  };

  return (
    <div className="min-h-screen hud-bg hex-bg p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Logo />
          <div className="font-mono text-xs text-white/60">CODE {sessionData.session_code}</div>
        </div>

        <div className="flex justify-between max-w-2xl mx-auto mb-8">
          {STEPS.map((label, i) => (
            <React.Fragment key={i}>
              <div className="flex flex-col items-center">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${i < step ? "bg-cyan text-void" : i === step ? "border-2 border-cyan animate-pulse-glow" : "border border-violet/40"
                  }`}>
                  {i < step ? <Check size={14} /> : <span className="font-mono text-xs">{i + 1}</span>}
                </div>
                <div className="label-mono mt-2">{label}</div>
              </div>
              {i < STEPS.length - 1 && <div className={`flex-1 h-0.5 mx-3 mt-5 ${i < step ? "bg-cyan" : "bg-violet/30"}`} />}
            </React.Fragment>
          ))}
        </div>

        <div className="glass rounded-2xl p-8" data-testid="verify-card">
          {step === 0 && (
            <Upper title="Upload Student ID — Front" subtitle="Photograph or upload the front of your university ID.">
              <FileSlot file={idFront} onChange={handleFile(setIdFront, true)} testid="id-front" />
              {ocrLoading && <div className="text-cyan text-sm mt-3 text-center animate-pulse">Extracting ID data...</div>}
              {extractedName && <div className="mt-3 text-xs text-white/60 text-center max-h-20 overflow-y-auto bg-elevated/50 p-2 rounded">Extracted Text: {extractedName}</div>}
              <Btns onNext={() => idFront ? setStep(1) : toast.error("Upload front first")} />
            </Upper>
          )}
          {step === 1 && (
            <Upper title="Upload Student ID — Back">
              <FileSlot file={idBack} onChange={handleFile(setIdBack)} testid="id-back" />
              <Btns onBack={() => setStep(0)} onNext={() => idBack ? setStep(2) : toast.error("Upload back first")} />
            </Upper>
          )}
          {step === 2 && (
            <Upper title="Take a Selfie" subtitle="Position your face inside the frame.">
              {cameraFailed ? (
                <div className="flex flex-col items-center">
                  <div className="mb-4 text-sm text-yellow-400">Live preview unavailable. Please use your camera app.</div>
                  <FileSlot file={selfie} onChange={handleFile(setSelfie)} testid="selfie-fallback" capture="user" />
                </div>
              ) : (
                <>
                  <CameraView videoRef={videoRef} canvasRef={canvasRef} captured={selfie} />
                  <div className="flex gap-2 mt-4 justify-center">
                    <button data-testid="capture-selfie-btn" onClick={() => setSelfie(captureFromCamera())}
                      className="btn-ghost-cyan rounded-md px-4 py-2 flex items-center gap-2"><Camera size={14} /> Capture</button>
                    {selfie && <button onClick={() => setSelfie(null)} className="btn-ghost-violet rounded-md px-4 py-2">Retake</button>}
                  </div>
                </>
              )}
              <Btns onBack={() => setStep(1)} onNext={() => selfie ? setStep(3) : toast.error("Capture selfie")} />
            </Upper>
          )}
          {step === 3 && (
            <Upper title="Liveness Check" subtitle={cameraFailed ? "Live video unavailable." : "Look at the camera and blink naturally for 6 seconds."}>
              {cameraFailed ? (
                <div className="text-center p-6 bg-elevated rounded-xl border border-violet/20">
                  <div className="text-yellow-400 mb-2">Bypassing liveness check (camera fallback mode).</div>
                  <button onClick={() => { setBlinks(-1); setStep(4); }} className="btn-cyan rounded-md px-5 py-2 mt-4">Continue to Verification</button>
                </div>
              ) : (
                <>
                  <CameraView videoRef={videoRef} canvasRef={canvasRef} liveness />
                  <div className="flex justify-center mt-4">
                    <button data-testid="liveness-btn" onClick={startLiveness} disabled={liveLoading}
                      className="btn-cyan rounded-md px-5 py-2 flex items-center gap-2">
                      <Eye size={14} /> {liveLoading ? "Detecting..." : "Start Liveness Check"}
                    </button>
                  </div>
                  {blinks > 0 && (
                    <div className="text-center mt-3 font-mono text-online">Blinks: {blinks}</div>
                  )}
                </>
              )}
              <Btns onBack={() => setStep(2)} hideNext />
            </Upper>
          )}
          {step === 4 && (
            <Upper title="Match Check" subtitle="Verifying that the selfie matches your student ID photo.">
              <div className="grid grid-cols-3 gap-3 my-4 items-center">
                <Thumb src={extractedFace || idFront} label="ID Face" />
                <div className="flex flex-col items-center gap-2">
                  <svg width="60" height="60" viewBox="0 0 60 60">
                    <circle cx="30" cy="30" r="28" fill="none"
                      stroke={matchScore == null ? "#B14CFF" : matchScore >= 0.45 ? "#39FF88" : "#FF3D71"}
                      strokeWidth="2"
                      strokeDasharray={`${(matchScore ?? 0) * 175.9} 175.9`}
                      transform="rotate(-90 30 30)"
                      style={{ transition: "stroke-dasharray 0.6s ease-out", filter: "drop-shadow(0 0 8px currentColor)" }}
                    />
                    <text x="30" y="34" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="12" fill="white">
                      {matchScore == null ? "—" : `${(matchScore * 100).toFixed(0)}%`}
                    </text>
                  </svg>
                  <div className="label-mono">MATCH</div>
                </div>
                <Thumb src={selfie} label="Selfie" />
              </div>

              <div className="glass rounded-lg p-4 grid grid-cols-4 gap-2 text-center font-mono text-xs">
                <div>
                  <div className="label-mono mb-1">NAME EXTRACT</div>
                  <div className={extractedName.toLowerCase().includes((studentData.full_name || "").toLowerCase()) ? "text-online" : "text-yellow-400"}>
                    {extractedName.toLowerCase().includes((studentData.full_name || "").toLowerCase()) ? "MATCH" : "MANUAL CHECK"}
                  </div>
                </div>
                <div>
                  <div className="label-mono mb-1">LIVENESS</div>
                  <div className={blinks >= 2 ? "text-online" : blinks === -1 ? "text-yellow-400" : "text-violation"}>
                    {blinks >= 2 ? `PASSED` : blinks === -1 ? "BYPASSED" : "FAILED"}
                  </div>
                </div>
                <div>
                  <div className="label-mono mb-1">FACE MATCH</div>
                  <div className={matchScore == null ? "text-white/40" : matchScore >= 0.45 ? "text-online" : "text-violation"}>
                    {matchScore == null ? "PENDING" : matchScore >= 0.45 ? "VERIFIED" : "LOW"}
                  </div>
                </div>
                <div>
                  <div className="label-mono mb-1">ID UPLOAD</div>
                  <div className="text-online">COMPLETE</div>
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <button data-testid="run-match-btn" onClick={runMatch} disabled={matching}
                  className="btn-ghost-cyan rounded-full px-5 py-2.5 flex items-center justify-center gap-2 flex-1">
                  {matching ? "Computing match..." : matchScore == null ? "Run Match Check" : "Re-run Check"}
                </button>
                <button data-testid="submit-verify-btn" onClick={submit}
                  disabled={submitting || matchScore == null}
                  className="btn-cyan rounded-full px-5 py-2.5 flex items-center justify-center gap-2 flex-1 disabled:opacity-40">
                  {submitting ? "Submitting..." : "Submit & Join"}
                </button>
              </div>
              <Btns onBack={() => setStep(3)} hideNext />
            </Upper>
          )}
        </div>
      </div>
    </div>
  );
}

const Upper = ({ title, subtitle, children }) => (
  <div>
    <h2 className="font-display text-2xl">{title}</h2>
    {subtitle && <p className="text-white/60 text-sm mt-1">{subtitle}</p>}
    <div className="mt-6">{children}</div>
  </div>
);

const Btns = ({ onBack, onNext, hideNext }) => (
  <div className="flex justify-between mt-6">
    {onBack ? <button onClick={onBack} className="btn-ghost-violet rounded-full px-5 py-2">Back</button> : <span />}
    {!hideNext && <button onClick={onNext} className="btn-cyan rounded-full px-5 py-2">Next</button>}
  </div>
);

const FileSlot = ({ file, onChange, testid, capture = "environment" }) => (
  <label className="block cursor-pointer">
    <div className="aspect-[3/2] rounded-xl border-2 border-dashed border-cyan/40 flex items-center justify-center bg-elevated/40 overflow-hidden">
      {file ? <img src={file} alt="" className="w-full h-full object-cover" /> :
        <div className="flex flex-col items-center text-cyan/70"><Upload size={28} /><span className="mt-2 text-sm">Click to upload</span></div>}
    </div>
    <input data-testid={testid} type="file" accept="image/*" capture={capture} className="hidden" onChange={onChange} />
  </label>
);

const CameraView = ({ videoRef, canvasRef, captured, liveness }) => (
  <div className="relative aspect-video rounded-xl overflow-hidden bg-elevated max-w-md mx-auto">
    <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
    {captured && <img src={captured} alt="" className="absolute inset-0 w-full h-full object-cover" />}
    {liveness && (
      <>
        <div className="absolute inset-0 border-2 border-cyan/60 rounded-xl animate-pulse-glow pointer-events-none" />
        <div className="absolute left-0 right-0 top-0 h-1 bg-gradient-to-b from-cyan/70 to-transparent animate-scanline" />
      </>
    )}
    <canvas ref={canvasRef} className="hidden" />
  </div>
);

const Thumb = ({ src, label }) => (
  <div>
    <div className="aspect-[3/2] rounded-lg overflow-hidden bg-elevated border border-cyan/20">
      {src && <img src={src} alt="" className="w-full h-full object-cover" />}
    </div>
    <div className="label-mono mt-1">{label}</div>
  </div>
);
