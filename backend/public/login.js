document.addEventListener('DOMContentLoaded', () => {
  const authForm = document.getElementById('auth-form');
  const formTitle = document.getElementById('form-title');
  const formSubtitle = document.getElementById('form-subtitle');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const confirmPasswordGroup = document.querySelector('.confirm-password-group');
  const confirmPasswordInput = document.getElementById('confirm-password');
  const btnSubmit = document.getElementById('btn-submit');
  const errorMsg = document.getElementById('error-msg');

  let isSignupMode = false;

  // Check auth status on load
  checkAuthStatus();

  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      
      if (!data.has_admin) {
        // First run setup: force Administrator account creation
        isSignupMode = true;
        formTitle.textContent = 'Setup Administrator';
        formSubtitle.textContent = 'Create the initial gateway administrator account';
        confirmPasswordGroup.style.display = 'block';
        confirmPasswordInput.required = true;
        btnSubmit.querySelector('span').textContent = 'Create Admin Account';
      } else {
        // Normal login mode
        isSignupMode = false;
        formTitle.textContent = 'SMS Gateway Login';
        formSubtitle.textContent = 'Sign in to access your dashboard';
        confirmPasswordGroup.style.display = 'none';
        confirmPasswordInput.required = false;
        btnSubmit.querySelector('span').textContent = 'Sign In';
      }
    } catch (err) {
      console.error('Failed to fetch authentication status:', err);
      showError('Unable to connect to authentication service.');
    }
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (isSignupMode) {
      const confirmPassword = confirmPasswordInput.value;
      if (password !== confirmPassword) {
        showError('Passwords do not match.');
        return;
      }
    }

    // Disable form fields
    btnSubmit.disabled = true;
    btnSubmit.querySelector('span').textContent = isSignupMode ? 'Creating...' : 'Signing In...';

    const url = isSignupMode ? '/api/auth/signup' : '/api/auth/login';

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (res.ok) {
        // Successful signup/login: redirect to dashboard
        window.location.href = '/';
      } else {
        const data = await res.json();
        showError(data.error || 'Authentication failed. Please try again.');
        btnSubmit.disabled = false;
        btnSubmit.querySelector('span').textContent = isSignupMode ? 'Create Admin Account' : 'Sign In';
      }
    } catch (err) {
      console.error('Authentication request error:', err);
      showError('Network error. Please verify server connection.');
      btnSubmit.disabled = false;
      btnSubmit.querySelector('span').textContent = isSignupMode ? 'Create Admin Account' : 'Sign In';
    }
  });

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.style.display = 'block';
  }

  function clearError() {
    errorMsg.textContent = '';
    errorMsg.style.display = 'none';
  }
});
