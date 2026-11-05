"use strict";

const $ = (selector) => document.querySelector(selector);
const authForm = $("#authForm");
const businessFieldNames = [
  "legal_business_name",
  "business_name",
  "business_registration_number",
  "business_structure",
  "registered_office_address",
  "shipping_address",
  "tax_pin_number",
  "signatory_id_number",
  "industry_category",
  "monthly_purchase_volume",
  "preferred_payment_method"
];
let authMode = new URLSearchParams(window.location.search).get("mode") === "login"
  ? "login"
  : "register";

function setAuthMode(mode) {
  authMode = mode;
  const isRegistering = mode === "register";
  $("#authTitle").textContent = isRegistering ? "Create your account" : "Log in";
  $("#authDescription").textContent = isRegistering
    ? "Create your business profile to get started with TradeCircle."
    : "Welcome back. Log in to your TradeCircle account.";
  $("#authNameField").hidden = !isRegistering;
  $("#authPhoneField").hidden = !isRegistering;
  $("#businessRegistrationFields").hidden = !isRegistering;
  $("#authTermsField").hidden = !isRegistering;
  $("#forgotPasswordButton").hidden = isRegistering;
  $(".auth-page-card").classList.toggle("is-business-registration", isRegistering);

  authForm.elements.namedItem("name").required = isRegistering;
  authForm.elements.namedItem("phone").required = isRegistering;
  authForm.elements.namedItem("terms_accepted").required = isRegistering;
  businessFieldNames.forEach((name) => {
    authForm.elements.namedItem(name).required = isRegistering;
  });
  const password = authForm.elements.namedItem("password");
  password.autocomplete = isRegistering ? "new-password" : "current-password";
  if (isRegistering) {
    password.minLength = 10;
  } else {
    password.removeAttribute("minlength");
  }

  $("#authSubmit").textContent = isRegistering ? "Create account" : "Log in";
  $("#authSwitchPrompt").textContent = isRegistering
    ? "Already have an account?"
    : "New to TradeCircle?";
  $("#authSwitchButton").textContent = isRegistering ? "Log in" : "Sign up";

  $("#registerModeButton").classList.toggle("is-active", isRegistering);
  $("#registerModeButton").setAttribute("aria-pressed", String(isRegistering));
  $("#loginModeButton").classList.toggle("is-active", !isRegistering);
  $("#loginModeButton").setAttribute("aria-pressed", String(!isRegistering));
  $("#authError").hidden = true;
  $("#authError").textContent = "";
  $("#authNotice").hidden = true;
  $("#authNotice").textContent = "";
  window.history.replaceState(null, "", `auth.html?mode=${mode}`);
}

async function submitAuth(event) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(authForm).entries());
  const payload = {
    email: values.email,
    password: values.password
  };

  if (authMode === "register") {
    payload.name = values.name;
    payload.phone = values.phone;
    payload.terms_accepted = values.terms_accepted === "true";
    payload.business_profile = {
      legal_business_name: values.legal_business_name,
      business_name: values.business_name,
      business_registration_number: values.business_registration_number,
      business_structure: values.business_structure,
      company_website: values.company_website || "",
      registered_office_address: values.registered_office_address,
      shipping_address: values.shipping_address,
      tax_pin_number: values.tax_pin_number,
      vat_registered: values.vat_registered === "true",
      signatory_id_number: values.signatory_id_number,
      industry_category: values.industry_category,
      monthly_purchase_volume: values.monthly_purchase_volume,
      preferred_payment_method: values.preferred_payment_method,
      trade_credit_requested: values.trade_credit_requested === "true"
    };
  }

  const submitButton = $("#authSubmit");
  const errorMessage = $("#authError");
  submitButton.disabled = true;
  errorMessage.hidden = true;

  try {
    const response = await fetch(`/api/auth/${authMode === "register" ? "register" : "login"}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Request failed (${response.status}).`);
    }

    window.location.assign("index.html");
  } catch (error) {
    errorMessage.textContent = error instanceof TypeError
      ? "Cannot reach the TradeCircle API. Start the backend and try again."
      : error.message;
    errorMessage.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
}

$("#registerModeButton").addEventListener("click", () => setAuthMode("register"));
$("#loginModeButton").addEventListener("click", () => setAuthMode("login"));
$("#authSwitchButton").addEventListener("click", () => {
  setAuthMode(authMode === "register" ? "login" : "register");
});
authForm.addEventListener("submit", (event) => void submitAuth(event));

$("#togglePasswordVisibility").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const password = authForm.elements.namedItem("password");
  const showPassword = password.type === "password";
  password.type = showPassword ? "text" : "password";
  button.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
  button.setAttribute("aria-pressed", String(showPassword));
  button.title = showPassword ? "Hide password" : "Show password";
  button.querySelector("i").className = `fas ${showPassword ? "fa-eye-slash" : "fa-eye"}`;
});

$("#forgotPasswordButton").addEventListener("click", () => {
  const notice = $("#authNotice");
  notice.textContent =
    "Password-reset email is not configured yet. Contact the TradeCircle administrator to reset your password.";
  notice.hidden = false;
});

setAuthMode(authMode);
