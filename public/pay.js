/**
 * SolidPay Payment Cashier Screen Logic
 * Handles QR display, UPI deep links, UTR submission, and real-time status polling.
 */

let currentOrder = null;
let countdownSeconds = 599; // 10 minutes
let countdownInterval = null;
let statusPollInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const outOrderNo = urlParams.get('outOrderNo');

  if (!outOrderNo) {
    showToast('No Order Number provided. Redirecting to home...', 'error');
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
    return;
  }

  loadOrder(outOrderNo);
  startTimer();
  initCopyButton();
  initUtrSubmission(outOrderNo);

  // Poll status every 4 seconds
  statusPollInterval = setInterval(() => {
    checkOrderStatus(outOrderNo);
  }, 4000);
});

async function loadOrder(outOrderNo) {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(outOrderNo)}`);
    const data = await res.json();

    if (!data.success || !data.order) {
      showToast('Order details not found.', 'error');
      return;
    }

    currentOrder = data.order;
    renderOrderDetails(currentOrder);

    // If order is already paid, go to success page
    if (currentOrder.status === 'PAID') {
      window.location.href = `/success.html?outOrderNo=${encodeURIComponent(outOrderNo)}`;
    }
  } catch (err) {
    console.error('Error loading order:', err);
    showToast('Failed to load order from gateway.', 'error');
  }
}

function renderOrderDetails(order) {
  const cashierAmount = document.getElementById('cashierAmount');
  const cashierOrderNo = document.getElementById('cashierOrderNo');
  const cashierQrImg = document.getElementById('cashierQrImg');
  const upiVpaText = document.getElementById('upiVpaText');
  const originalDeskLink = document.getElementById('originalDeskLink');

  if (cashierAmount) cashierAmount.textContent = `₹${Number(order.inrAmount).toFixed(2)}`;
  if (cashierOrderNo) cashierOrderNo.textContent = order.outOrderNo;

  if (cashierQrImg && order.qrCodeDataUrl) {
    cashierQrImg.src = order.qrCodeDataUrl;
  }

  const vpa = order.upi || 'Payment Gateway Desk';
  if (upiVpaText) upiVpaText.textContent = `UPI: ${vpa}`;

  if (originalDeskLink && order.payUrl) {
    originalDeskLink.href = order.payUrl;
  }

  // UPI Deep Links
  const rawUpiLink = order.upiLink || '';
  const genericUpiLink = document.getElementById('genericUpiLink');
  const phonepeLink = document.getElementById('phonepeLink');
  const gpayLink = document.getElementById('gpayLink');
  const paytmLink = document.getElementById('paytmLink');

  if (genericUpiLink) genericUpiLink.href = rawUpiLink || '#';

  if (rawUpiLink) {
    // Generate specialized schemes
    const cleanLink = rawUpiLink.replace(/^upi:\/\//i, '');
    if (phonepeLink) phonepeLink.href = `phonepe://${cleanLink}`;
    if (gpayLink) gpayLink.href = `tez://upi/${cleanLink}`;
    if (paytmLink) paytmLink.href = `paytmmp://${cleanLink}`;
  }
}

async function checkOrderStatus(outOrderNo) {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(outOrderNo)}`);
    const data = await res.json();
    if (data.success && data.order) {
      if (data.order.status === 'PAID') {
        clearInterval(statusPollInterval);
        clearInterval(countdownInterval);
        showToast('Payment detected successfully! Redirecting...', 'success');
        setTimeout(() => {
          window.location.href = `/success.html?outOrderNo=${encodeURIComponent(outOrderNo)}`;
        }, 1200);
      }
    }
  } catch (e) {
    // Silent fail on poll
  }
}

function startTimer() {
  const timerEl = document.getElementById('countdownTimer');
  if (!timerEl) return;

  countdownInterval = setInterval(() => {
    countdownSeconds--;
    if (countdownSeconds <= 0) {
      clearInterval(countdownInterval);
      clearInterval(statusPollInterval);
      timerEl.textContent = '00:00 (Expired)';
      showToast('Payment session expired. Please create a new order.', 'error');
      return;
    }

    const mins = Math.floor(countdownSeconds / 60);
    const secs = countdownSeconds % 60;
    timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

function initCopyButton() {
  const copyBtn = document.getElementById('btnCopyVpa');
  if (!copyBtn) return;

  copyBtn.addEventListener('click', () => {
    const vpa = (currentOrder && currentOrder.upi) ? currentOrder.upi : '';
    if (!vpa) return;

    navigator.clipboard.writeText(vpa).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = 'Copy UPI';
      }, 2000);
    }).catch(() => {
      showToast('Could not copy automatically.', 'error');
    });
  });
}

function initUtrSubmission(outOrderNo) {
  const submitBtn = document.getElementById('btnSubmitUtr');
  const utrInput = document.getElementById('utrInput');

  if (!submitBtn || !utrInput) return;

  submitBtn.addEventListener('click', async () => {
    const utr = utrInput.value.trim();

    if (!/^\d{12}$/.test(utr)) {
      showToast('Please enter a valid 12-digit numeric UTR number.', 'error');
      utrInput.focus();
      return;
    }

    submitBtn.textContent = 'Verifying...';
    submitBtn.disabled = true;

    try {
      const res = await fetch('/api/orders/utr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outOrderNo, utr })
      });

      const data = await res.json();
      if (data.success) {
        showToast('UTR Confirmed! Payment Success!', 'success');
        setTimeout(() => {
          window.location.href = `/success.html?outOrderNo=${encodeURIComponent(outOrderNo)}&utr=${encodeURIComponent(utr)}`;
        }, 1000);
      } else {
        showToast(data.msg || 'Verification failed. Try again.', 'error');
        submitBtn.textContent = 'Confirm';
        submitBtn.disabled = false;
      }
    } catch (err) {
      showToast(`Network Error: ${err.message}`, 'error');
      submitBtn.textContent = 'Confirm';
      submitBtn.disabled = false;
    }
  });
}

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
