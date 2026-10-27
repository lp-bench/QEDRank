import QRSR_p001_sum_bound_lower_bound
import QRSM_p001_sum_bound_lower_bound_qwen_a1r0
import QEDRank.Audit

set_option maxHeartbeats 200000

#qr_compare QRRef.lower_bound QRModel.placeholder_statement
#qr_mk_prop QR_ref_prop := QRRef.lower_bound
#qr_mk_prop QR_model_prop := QRModel.placeholder_statement

/-- reference ⇒ model -/
def QR_fwd (h : QR_ref_prop) : QR_model_prop := by
  delta QR_ref_prop at h
  delta QR_model_prop
  first
    | exact h
    | (simpa using h)
    | (intros; simp_all)
    | (intros; aesop)
    | (intros; omega)
    | (intros; exact?)
#qr_uses_hyp QR_fwd
#qr_axioms QR_fwd

/-- model ⇒ reference -/
def QR_bwd (h : QR_model_prop) : QR_ref_prop := by
  delta QR_model_prop at h
  delta QR_ref_prop
  first
    | exact h
    | (simpa using h)
    | (intros; simp_all)
    | (intros; aesop)
    | (intros; omega)
    | (intros; exact?)
#qr_uses_hyp QR_bwd
#qr_axioms QR_bwd

/-- is the model statement provable outright by the same automation? -/
def QR_model_outright : QR_model_prop := by
  delta QR_model_prop
  first
    | (intros; simp_all)
    | (intros; aesop)
    | (intros; omega)
    | decide
    | (intros; exact?)
#qr_axioms QR_model_outright

/-- is the reference statement provable outright by the same automation? -/
def QR_ref_outright : QR_ref_prop := by
  delta QR_ref_prop
  first
    | (intros; simp_all)
    | (intros; aesop)
    | (intros; omega)
    | decide
    | (intros; exact?)
#qr_axioms QR_ref_outright
