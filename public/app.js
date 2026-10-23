/**
 * SolidPay Frontend Application Logic
 * Clean, direct payment flow: Enter amount -> Click Pay -> Redirect to Gateway
 */

let appConfig = {
  merchantId: '1035',
  minAmount: 100,
  maxAmount: 50000,
  currency: 'INR'
};

document.addEventListener('DOMContentLoaded', () => {
  initAmountInputs();
  initFormSubmission();
  fetchConfig();
});

// -------------------------------------------------------------
// Configuration Fetch
// -------------------------------------------------------------
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.success) {
      appConfig = { ...appConfig, ...data };
      const limitsHint = document.getElementById('limitsHint');
      if (limitsHint) {
        limitsHint.textContent = `Limits: ₹${appConfig.minAmount.toFixed(2)} – ₹${appConfig.maxAmount.toLocaleString('en-IN')}.00`;
      }
    }
  } catch (err) {
    console.warn('Could not fetch config:', err);
  }
}

// -------------------------------------------------------------
// Amount Inputs & Real-Time Calculation
// -------------------------------------------------------------
function initAmountInputs() {
  const amountInput = document.getElementById('amountInput');
  const presetChips = document.querySelectorAll('.preset-chip');
  const totalDisplay = document.getElementById('totalDisplay');

  if (!amountInput) return;

  function handleAmountChange() {
    const val = parseFloat(amountInput.value) || 0;
    if (totalDisplay) {
      totalDisplay.textContent = `₹${val.toFixed(2)}`;
    }

    // Update active preset chip
    presetChips.forEach(chip => {
      const chipAmount = parseFloat(chip.getAttribute('data-amount'));
      if (chipAmount === val) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
  }

  amountInput.addEventListener('input', handleAmountChange);
  amountInput.addEventListener('change', handleAmountChange);

  // Preset chips click
  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const chipVal = chip.getAttribute('data-amount');
      amountInput.value = chipVal;
      handleAmountChange();
    });
  });

  handleAmountChange();
}

// -------------------------------------------------------------
// Payment Form Submission & Instant Redirection
// -------------------------------------------------------------
function initFormSubmission() {
  const payBtn = document.getElementById('payButton');
  const btnText = document.getElementById('btnText');
  const amountInput = document.getElementById('amountInput');

  if (!payBtn || !amountInput) return;

  payBtn.addEventListener('click', async () => {
    const rawVal = amountInput.value.trim();
    const amountNum = parseFloat(rawVal);

    if (isNaN(amountNum) || amountNum < appConfig.minAmount || amountNum > appConfig.maxAmount) {
      showToast(`Amount must be between ₹${appConfig.minAmount} and ₹${appConfig.maxAmount}`, 'error');
      amountInput.focus();
      return;
    }

    // Set loading state
    payBtn.classList.add('loading');
    payBtn.disabled = true;
    if (btnText) btnText.textContent = 'Redirecting to Gateway...';

    try {
      const payload = {
        amount: amountNum
      };

      const res = await fetch('/api/payin/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (data.success && data.data && data.data.payUrl) {
        showToast('Payment initiated! Redirecting...', 'success');
        // Immediate redirection to the gateway payment page
        window.location.href = data.data.payUrl;
      } else {
        const errorMsg = data.msg || (data.gatewayResponse && data.gatewayResponse.msg) || 'Failed to create payment order.';
        showToast(errorMsg, 'error');
        payBtn.classList.remove('loading');
        payBtn.disabled = false;
        if (btnText) btnText.textContent = 'Pay Now →';
      }
    } catch (err) {
      console.error('Payment Error:', err);
      showToast(`Network Error: ${err.message}`, 'error');
      payBtn.classList.remove('loading');
      payBtn.disabled = false;
      if (btnText) btnText.textContent = 'Pay Now →';
    }
  });
}

// -------------------------------------------------------------
// Toast Notification
// -------------------------------------------------------------
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${msg}</span>`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
