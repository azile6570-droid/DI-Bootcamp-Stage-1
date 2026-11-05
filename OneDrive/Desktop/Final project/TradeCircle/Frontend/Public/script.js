

"use strict";

let products = [];
const productUnitNames = {
  bag: "bag",
  sack: "sack",
  carton: "carton",
  case: "case",
  bale: "bale",
  crate: "crate",
  jerrycan: "jerrycan",
  drum: "drum",
  bundle: "bundle",
  unit: "unit"
};
const productUnitOptions = (selected = "unit") =>
  Object.entries(productUnitNames).map(([value, name]) =>
    `<option value="${value}" ${selected === value ? "selected" : ""}>${name[0].toUpperCase()}${name.slice(1)}</option>`
  ).join("");
const formatUnits = (quantity, unit) => {
  const label = productUnitNames[unit] || "unit";
  return `${quantity} ${Number(quantity) === 1 ? label : `${label}s`}`;
};
const pluralUnitLabel = (unit) => `${productUnitNames[unit] || "unit"}s`;
function productPackageLabel(product) {
  const packCount = product.name.match(/\((\d+)\)/);
  if (packCount) {
    return `${packCount[1]} per ${productUnitNames[product.unit] || "unit"}`;
  }

  const size = product.name.match(/\b(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/i);
  if (size) {
    return `${size[1]} ${size[2].toUpperCase()} per ${productUnitNames[product.unit] || "unit"}`;
  }

  return `Wholesale ${productUnitNames[product.unit] || "unit"}`;
}

const state = {
  category: "All",
  search: "",
  sort: "featured",
  showWishlistOnly: false,
  reviewProduct: null,
  dealCheckout: null,
  cart: {},
  wishlist: new Set(),
  deals: [],
  user: null,
  dashboardMode: "buying",
  productsLoading: true,
  productsError: "",
  adminData: {},
  salesData: { clients: [], followups: [], rfqs: [] },
  adminPreviewMode: "buyer"
};

let adminActivityTimer = null;

const CURRENT_TERMS_VERSION = "2026-10-28";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);
const localBackend = "/api";
const API_BASE = window.TRADECIRCLE_API_URL || localBackend;
const userHasRole = (role) => {
  if (!state.user || state.user.role === "admin") return false;
  if (role === "buyer") {
    return ["buyer", "supplier", "buyer_supplier"].includes(state.user.role);
  }
  if (role === "supplier") {
    return state.user.supplier_verified === true &&
      ["supplier", "buyer_supplier"].includes(state.user.role);
  }
  return state.user.role === role;
};

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        "Cannot reach the TradeCircle API. Start the backend and open the site from its local URL."
      );
    }
    throw error;
  }
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 405) {
      throw new Error(
        "The API returned 405. Start the TradeCircle backend and open the site from its local URL."
      );
    }
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const formatKES = (amount) =>
  new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency: "KES",
    maximumFractionDigits: 2
  }).format(amount);

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function normalizeProduct(product) {
  return {
    id: Number(product.id),
    name: product.name,
    category: product.category,
    supplier: product.supplier_name,
    supplierVerified: product.supplier_verified === true,
    reviewCount: Number(product.review_count || 0),
    averageRating: Number(product.average_rating || 0),
    price: Number(product.wholesale_price),
    unit: product.unit_label || "unit",
    minOrder: Number(product.minimum_quantity),
    stock: Number(product.stock_quantity),
    image: product.image_url || "",
    imageCredit: product.image_url?.includes("upload.wikimedia.org")
      ? "Photo by TooHotToHandle, CC BY-SA 3.0"
      : "",
    description: product.description || ""
  };
}

function normalizeDeal(deal) {
  return {
    id: Number(deal.id),
    title: deal.name,
    description: deal.description || `Join a shared wholesale order for ${deal.name}.`,
    productId: Number(deal.product_id),
    target: Number(deal.target_quantity),
    joined: Number(deal.current_quantity),
    unit: deal.unit_label || "unit",
    price: Number(deal.discounted_price),
    listPrice: Number(deal.wholesale_price),
    image: deal.image_url || "",
    minOrder: Number(deal.minimum_quantity),
    endsAt: deal.ends_at ? Date.parse(deal.ends_at) : null
  };
}

function renderProducts() {
  $("#wishlistCount").textContent = state.wishlist.size;
  let visible = products.filter((product) => {
    const matchesCategory =
      state.category === "All" || product.category === state.category;

    const searchText = [
      product.name,
      product.category,
      product.supplier
    ].join(" ").toLowerCase();

    const matchesWishlist =
      !state.showWishlistOnly || state.wishlist.has(product.id);
    return matchesCategory && matchesWishlist &&
      searchText.includes(state.search.toLowerCase());
  });

  if (state.sort === "price-low") {
    visible.sort((a, b) => a.price - b.price);
  } else if (state.sort === "price-high") {
    visible.sort((a, b) => b.price - a.price);
  } else if (state.sort === "name") {
    visible.sort((a, b) => a.name.localeCompare(b.name));
  }

  $("#productGrid").innerHTML = visible.map((product) => {
    const featuredDeal = state.deals.find((deal) =>
      deal.productId === product.id &&
      deal.price < deal.listPrice &&
      (!Number.isFinite(deal.endsAt) || deal.endsAt > Date.now()) &&
      deal.joined < deal.target
    );
    const discountPercent = featuredDeal
      ? Math.round((1 - featuredDeal.price / featuredDeal.listPrice) * 100)
      : 0;
    return `
    <div class="column is-3-desktop is-4-tablet is-6-mobile">
      <article class="product-card">
        <div class="product-image">
          ${product.image
            ? `<img data-product-image src="${escapeHTML(product.image)}" alt="${escapeHTML(product.name)}" loading="lazy" decoding="async">`
            : `<div class="product-image-placeholder"><i class="fas fa-box-open"></i></div>`}
          ${product.imageCredit
            ? `<a class="product-image-credit" href="https://commons.wikimedia.org/wiki/File:Blue_reusable_shopping_bag.JPG" target="_blank" rel="noopener noreferrer">${escapeHTML(product.imageCredit)}</a>`
            : ""}
          ${discountPercent > 0
            ? `<span class="product-discount-badge"><i class="fas fa-tag" aria-hidden="true"></i> SAVE ${discountPercent}%</span>`
            : ""}
          <span class="product-tag">Wholesale · min ${formatUnits(product.minOrder, product.unit)}</span>
          ${state.user?.role !== "admin" ? `
            <button class="wishlist-button ${state.wishlist.has(product.id) ? "is-saved" : ""}"
                    type="button" data-toggle-wishlist="${product.id}"
                    aria-label="${state.wishlist.has(product.id) ? "Remove from" : "Save to"} wishlist: ${escapeHTML(product.name)}"
                    aria-pressed="${state.wishlist.has(product.id)}">
              <i class="${state.wishlist.has(product.id) ? "fas" : "far"} fa-heart" aria-hidden="true"></i>
            </button>` : ""}
          <span class="product-pack-label">
            <i class="fas fa-boxes-stacked" aria-hidden="true"></i>
            ${escapeHTML(productPackageLabel(product))}
          </span>
        </div>
        <div class="product-body">
          <span class="product-category">${escapeHTML(product.category)}</span>
          <span class="supplier-name">
            <i class="fas fa-store" aria-hidden="true"></i>
            ${escapeHTML(product.supplier)}
            ${product.supplierVerified
              ? '<span class="verified-badge"><i class="fas fa-circle-check" aria-hidden="true"></i> Verified</span>'
              : ""}
          </span>
          <h3 class="product-title">${escapeHTML(product.name)}</h3>
          <div class="product-rating" aria-label="${product.reviewCount
            ? `${product.averageRating.toFixed(1)} out of 5 from ${product.reviewCount} reviews`
            : "No reviews yet"}">
            <span class="rating-stars" aria-hidden="true">${"★".repeat(Math.round(product.averageRating))}${"☆".repeat(5 - Math.round(product.averageRating))}</span>
            <span>${product.reviewCount
              ? `${product.averageRating.toFixed(1)} (${product.reviewCount})`
              : "No reviews yet"}</span>
            <button type="button" class="review-open-button"
                    data-open-reviews="${product.id}">
              ${product.reviewCount ? "Read reviews" : "Review"}
            </button>
          </div>
          <p class="product-description">${escapeHTML(product.description)}</p>
          <div class="product-meta">
            <span>Minimum order</span>
            <strong>${formatUnits(product.minOrder, product.unit)}</strong>
          </div>
          <div class="product-price">
            <strong>${formatKES(product.price)}</strong>
            <span>per ${escapeHTML(product.unit)}</span>
          </div>
          <div class="bulk-price">${formatUnits(product.stock, product.unit)} available</div>
          ${state.user?.role !== "admin" ? `
            <div class="product-actions">
              <button class="add-button" data-add-product="${product.id}">
                <i class="fas fa-plus mr-1"></i> Add to cart
              </button>
            </div>` : ""}
        </div>
      </article>
    </div>
  `;
  }).join("");

  const emptyProducts = $("#emptyProducts");
  emptyProducts.hidden = visible.length !== 0;
  if (!visible.length) {
    emptyProducts.textContent = state.productsLoading
      ? "Loading approved wholesale products..."
      : state.productsError || (state.showWishlistOnly
        ? "You have not saved any products yet."
        : "No approved products match your search or category.");
  }
}

function renderReviewDialog(reviews, summary) {
  const product = state.reviewProduct;
  if (!product) return;

  $("#reviewDialogTitle").textContent = `Reviews for ${product.name}`;
  $("#reviewSummary").textContent = summary.review_count
    ? `${Number(summary.average_rating).toFixed(1)} out of 5 · ${summary.review_count} verified-buyer review${Number(summary.review_count) === 1 ? "" : "s"}`
    : "No reviews yet. Reviews are written by buyers after delivery.";
  $("#reviewList").innerHTML = reviews.length
    ? reviews.map((review) => `
        <article class="review-entry">
          <div class="review-entry-heading">
            <strong>${escapeHTML(review.reviewer_name)}</strong>
            <span class="rating-stars" aria-label="${review.rating} out of 5">
              ${"★".repeat(Number(review.rating))}${"☆".repeat(5 - Number(review.rating))}
            </span>
          </div>
          <small>${displayDate(review.created_at)} · Verified purchase</small>
          ${review.review_text
            ? `<p>${escapeHTML(review.review_text)}</p>`
            : "<p>Buyer left a rating without a written review.</p>"}
        </article>
      `).join("")
    : '<p class="dashboard-empty">No reviews yet.</p>';

  const formContainer = $("#reviewFormContainer");
  if (!state.user || !userHasRole("buyer")) {
    formContainer.innerHTML = `
      <p class="review-eligibility">Only buyers who have paid for and received this product can leave a review.</p>
      <button class="button primary-button is-fullwidth" type="button" data-review-sign-in>
        Sign in as a buyer to review
      </button>`;
    return;
  }

  formContainer.innerHTML = `
    <p class="review-eligibility">Verified buyers can review after their order is paid and delivered.</p>
    <form id="productReviewForm" class="review-form">
      <label>Rating
        <select name="rating" required>
          <option value="5">5 — Excellent</option>
          <option value="4">4 — Good</option>
          <option value="3">3 — Okay</option>
          <option value="2">2 — Poor</option>
          <option value="1">1 — Very poor</option>
        </select>
      </label>
      <label>Your review (optional)
        <textarea name="review_text" rows="3" maxlength="1000"
                  placeholder="Share your experience with this product"></textarea>
      </label>
      <p class="review-form-error" id="reviewFormError" role="alert" hidden></p>
      <button class="button primary-button is-fullwidth" type="submit">Submit verified review</button>
    </form>`;
}

async function openProductReviews(productId) {
  const product = products.find((item) => item.id === productId);
  if (!product) return;

  state.reviewProduct = product;
  $("#reviewList").innerHTML = '<p class="dashboard-empty">Loading reviews…</p>';
  $("#reviewSummary").textContent = "";
  $("#reviewDialogOverlay").hidden = false;

  try {
    const result = await apiRequest(`/reviews/${productId}`);
    renderReviewDialog(result.reviews, result.summary);
  } catch (error) {
    $("#reviewList").innerHTML =
      `<p class="review-form-error">Unable to load reviews: ${escapeHTML(error.message)}</p>`;
  }
}

function renderDeals() {
  const dealGrid = $("#dealGrid");
  if (!dealGrid) return;

  dealGrid.innerHTML = state.deals.map((deal) => {
    const percent = Math.min(100, Math.round(deal.joined / deal.target * 100));
    const remaining = Math.max(0, deal.target - deal.joined);
    const expired = Number.isFinite(deal.endsAt) && deal.endsAt <= Date.now();
    const savingsPerUnit = Math.max(0, deal.listPrice - deal.price);

    return `
      <div class="column is-4">
        <article class="deal-card">
          ${deal.image
            ? `<img class="deal-image" src="${escapeHTML(deal.image)}" alt="${escapeHTML(deal.title)}" loading="lazy">`
            : `<div class="deal-image deal-image-placeholder"><i class="fas fa-people-group"></i></div>`}
          <div class="deal-body">
            <span class="deal-status">
              <i class="fas fa-users mr-1"></i>
              ${percent >= 100 ? "Target reached" : "Group deal in progress"}
            </span>
            <h3>${escapeHTML(deal.title)}</h3>
            <p>${escapeHTML(deal.description)}</p>
            <div class="deal-price-row">
              <strong>${formatKES(deal.price)}</strong>
              <span>per ${escapeHTML(deal.unit.replace(/s$/, ""))} at target
                ${savingsPerUnit > 0
                  ? `<small class="deal-regular-price">Regularly ${formatKES(deal.listPrice)}</small>`
                  : ""}
                ${savingsPerUnit > 0
                  ? `<small>Save ${formatKES(savingsPerUnit)} per unit</small>`
                  : ""}
              </span>
            </div>
            ${Number.isFinite(deal.endsAt)
              ? `<p class="deal-countdown" data-deal-countdown="${deal.id}" data-ends-at="${deal.endsAt}" role="timer" aria-live="off"></p>`
              : ""}
            <div class="progress-track"
                 role="progressbar"
                 aria-label="${escapeHTML(deal.title)} target progress"
                 aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-fill" style="width:${percent}%"></div>
            </div>
            <div class="deal-progress-label">
              <span>${deal.joined.toLocaleString()} / ${deal.target.toLocaleString()} ${escapeHTML(deal.unit)}</span>
              <strong>${percent}%</strong>
            </div>
            ${["admin", "sales"].includes(state.user?.role)
              ? '<p class="deal-savings">Group-deal checkout is available to buyer accounts.</p>'
              : `
                <label class="deal-calculator">
                  <span>How many ${escapeHTML(deal.unit)} do you need?</span>
                  <input class="deal-quantity" type="number" inputmode="numeric"
                         min="${deal.minOrder}" max="${remaining}"
                         value="${Math.min(deal.minOrder, remaining)}"
                         data-calculator-deal="${deal.id}"
                         ${percent >= 100 || expired || remaining < deal.minOrder ? "disabled" : ""}
                         aria-label="Quantity of ${escapeHTML(deal.title)}">
                </label>
                <p class="deal-savings" data-savings-deal="${deal.id}" aria-live="polite">
                  ${savingsPerUnit > 0
                    ? `Estimated saving: ${formatKES(savingsPerUnit * Math.min(deal.minOrder, remaining))}`
                    : "No saving compared with the current listed price"}
                </p>
                <button class="deal-join" data-join-deal="${deal.id}"
                        ${percent >= 100 || expired || remaining < deal.minOrder ? "disabled" : ""}>
                  ${expired ? "Deal expired" : percent >= 100 ? "Target reached" : "Join group deal"}
                </button>`}
          </div>
        </article>
      </div>
    `;
  }).join("");

  updateDealCountdowns();

  if (!state.deals.length) {
    dealGrid.innerHTML = `
      <div class="column is-12">
        <p class="empty-message">No active group deals are available right now.</p>
      </div>`;
  }
}

function updateDealCountdowns() {
  const now = Date.now();
  $$("[data-deal-countdown]").forEach((timer) => {
    const endsAt = Number(timer.dataset.endsAt);
    const secondsLeft = Math.floor((endsAt - now) / 1000);
    const card = timer.closest(".deal-card");
    const joinButton = card.querySelector("[data-join-deal]");

    if (!Number.isFinite(endsAt) || secondsLeft <= 0) {
      timer.textContent = "Deal expired";
      if (joinButton) {
        joinButton.disabled = true;
        joinButton.textContent = "Deal expired";
      }
      return;
    }

    const days = Math.floor(secondsLeft / 86400);
    const hours = Math.floor((secondsLeft % 86400) / 3600);
    const minutes = Math.floor((secondsLeft % 3600) / 60);
    const seconds = secondsLeft % 60;
    const timeLeft = days > 0
      ? `${days}d ${hours}h ${minutes}m`
      : `${hours}h ${minutes}m ${seconds}s`;
    timer.innerHTML = `<i class="fas fa-clock" aria-hidden="true"></i> Ends in ${timeLeft}`;
  });
}

function updateDealSavings(dealId, quantity) {
  const deal = state.deals.find((item) => item.id === dealId);
  const output = $(`[data-savings-deal="${dealId}"]`);
  if (!deal || !output) return;

  const savingsPerUnit = Math.max(0, deal.listPrice - deal.price);
  output.textContent = savingsPerUnit > 0
    ? `Estimated saving: ${formatKES(savingsPerUnit * quantity)}`
    : "No saving compared with the current listed price";
}

function openDealCheckout(deal, quantity) {
  state.dealCheckout = { dealId: deal.id, quantity };
  $("#dealCheckoutSummary").textContent =
    `${deal.title} · ${formatUnits(quantity, deal.unit)} × ${formatKES(deal.price)} = ${formatKES(quantity * deal.price)}.`;
  $("#dealCheckoutError").hidden = true;
  $("#dealCheckoutForm").reset();
  $("#dealCheckoutOverlay").hidden = false;
  $("#dealCheckoutForm").elements.namedItem("phone").focus();
}

async function loadProducts() {
  try {
    const payload = await apiRequest("/products");
    products = payload.products.map(normalizeProduct);
    state.productsError = "";
    return true;
  } catch (error) {
    state.productsError = `Unable to load products: ${error.message}`;
    return false;
  } finally {
    state.productsLoading = false;
    renderProducts();
    renderQuickOrderPad();
    updateSalesProductCategories();
    renderSalesProducts();
  }
}

async function loadDeals() {
  try {
    const payload = await apiRequest("/deals");
    state.deals = payload.deals.map(normalizeDeal);
  } catch (error) {
    const dealGrid = $("#dealGrid");
    if (dealGrid) {
      dealGrid.innerHTML = `
        <div class="column is-12">
          <p class="empty-message">Unable to load group deals: ${escapeHTML(error.message)}</p>
        </div>`;
    }
    return false;
  }
  renderDeals();
  renderProducts();
  return true;
}

async function loadWishlist() {
  if (!state.user || !userHasRole("buyer")) {
    state.wishlist.clear();
    renderProducts();
    return;
  }

  try {
    const result = await apiRequest("/wishlist");
    state.wishlist = new Set(result.products.map((product) => Number(product.id)));
    renderProducts();
  } catch (error) {
    if (error.status !== 401) showToast(`Unable to load your wishlist: ${error.message}`);
  }
}

async function toggleWishlist(productId, button) {
  if (!state.user) {
    openAuth();
    showToast("Sign in as a buyer to save products.");
    return;
  }
  if (!userHasRole("buyer")) {
    showToast("Wishlists are available to buyer accounts.");
    return;
  }

  button.disabled = true;
  const isSaved = state.wishlist.has(productId);
  try {
    await apiRequest(
      isSaved ? `/wishlist/${productId}` : "/wishlist",
      isSaved
        ? { method: "DELETE" }
        : { method: "POST", body: JSON.stringify({ product_id: productId }) }
    );
    if (isSaved) state.wishlist.delete(productId);
    else state.wishlist.add(productId);
    renderProducts();
    showToast(isSaved ? "Removed from your wishlist." : "Saved to your wishlist.");
  } catch (error) {
    showToast(`Unable to update your wishlist: ${error.message}`);
    button.disabled = false;
  }
}

function cartQuantity() {
  return Object.values(state.cart).reduce((total, item) => total + item.quantity, 0);
}

function cartTotal() {
  return Object.values(state.cart).reduce(
    (total, item) => total + item.price * item.quantity, 0
  );
}

function renderCart() {
  const items = Object.values(state.cart);

  $("#cartCount").textContent = cartQuantity();
  $("#mobileCartCount").textContent = cartQuantity();
  $("#cartSubtotal").textContent = formatKES(cartTotal());

  if (!items.length) {
    $("#cartItems").innerHTML = `
      <div class="cart-empty">
        <i class="fas fa-basket-shopping fa-2x mb-3"></i>
        <p>Your cart is empty.</p>
        <p class="mt-2">Explore the catalogue to find products for your business.</p>
      </div>`;
    return;
  }

  $("#cartItems").innerHTML = items.map((item) => `
    <div class="cart-row">
      ${item.image
        ? `<img src="${escapeHTML(item.image)}" alt="">`
        : `<span class="cart-image-placeholder"><i class="fas fa-box-open"></i></span>`}
      <div>
        <strong>${escapeHTML(item.name)}</strong>
        <small>${formatKES(item.price)} / ${escapeHTML(item.unit)}</small>
        <label class="is-size-7">
          Quantity (${escapeHTML(item.unit)})
          <input type="number" min="1" max="100000"
                 value="${item.quantity}" data-cart-quantity="${item.id}"
                 aria-label="Quantity of ${escapeHTML(item.name)}">
        </label>
      </div>
      <div class="has-text-right">
        <strong>${formatKES(item.price * item.quantity)}</strong>
        <button class="cart-remove is-block mt-2"
                data-remove-product="${item.id}">Remove</button>
      </div>
    </div>
  `).join("");
}

function addToCart(productId) {
  if (["admin", "sales"].includes(state.user?.role)) return;
  const product = products.find((item) => item.id === productId);
  if (!product) return;

  if (!state.cart[productId]) {
    state.cart[productId] = {
      ...product,
      quantity: product.minOrder
    };
    showToast(`${product.name} added. Initial quantity is the minimum order of ${formatUnits(product.minOrder, product.unit)}.`);
  } else {
    state.cart[productId].quantity += product.minOrder;
    showToast(`Added another minimum order of ${formatUnits(product.minOrder, product.unit)}.`);
  }

  renderCart();
}

function quickOrderRowMarkup(productId = "", quantity = "") {
  const options = products.map((product) => `
    <option value="${product.id}" ${String(product.id) === String(productId) ? "selected" : ""}
            ${product.stock < product.minOrder ? "disabled" : ""}>
      ${escapeHTML(product.name)} · ${formatKES(product.price)} / ${escapeHTML(product.unit)}
      · min ${product.minOrder}${product.stock < product.minOrder ? " · unavailable" : ""}
    </option>
  `).join("");
  return `
    <div class="quick-order-line" data-quick-order-line>
      <label>
        Product
        <select data-quick-order-product required>
          <option value="">Choose a wholesale product</option>${options}
        </select>
        <small data-quick-order-guidance>Select a product to see its minimum and stock.</small>
      </label>
      <label>
        Quantity
        <input data-quick-order-quantity type="number" min="1" max="100000"
               step="1" value="${escapeHTML(quantity)}" required>
      </label>
      <button class="quick-order-remove" type="button" data-remove-quick-order-line
              aria-label="Remove item" title="Remove item">
        <i class="fas fa-xmark" aria-hidden="true"></i>
      </button>
    </div>`;
}

function updateQuickOrderLine(row, resetQuantity = false) {
  const productId = Number(row.querySelector("[data-quick-order-product]").value);
  const quantityInput = row.querySelector("[data-quick-order-quantity]");
  const guidance = row.querySelector("[data-quick-order-guidance]");
  const product = products.find((item) => item.id === productId);

  if (!product) {
    quantityInput.min = "1";
    quantityInput.max = "100000";
    quantityInput.value = "";
    guidance.textContent = "Select a product to see its minimum and stock.";
    return;
  }

  quantityInput.min = String(product.minOrder);
  quantityInput.max = String(product.stock);
  if (resetQuantity || !quantityInput.value) {
    quantityInput.value = String(product.minOrder);
  }
  guidance.textContent = `Minimum ${formatUnits(product.minOrder, product.unit)} · ${formatUnits(product.stock, product.unit)} available`;
}

function renderQuickOrderPad() {
  const lines = $("#quickOrderLines");
  if (!lines) return;

  const existingLines = [...lines.querySelectorAll("[data-quick-order-line]")]
    .map((row) => ({
      productId: row.querySelector("[data-quick-order-product]").value,
      quantity: row.querySelector("[data-quick-order-quantity]").value
    }));
  const rows = existingLines.length ? existingLines : [{}];
  lines.innerHTML = rows.map((row) =>
    quickOrderRowMarkup(row.productId, row.quantity)
  ).join("");
  lines.querySelectorAll("[data-quick-order-line]").forEach((row) => {
    updateQuickOrderLine(row);
  });

  const hasAvailableProducts = products.some((product) => product.stock >= product.minOrder);
  $("#quickOrderEmpty").hidden = hasAvailableProducts;
  $("#quickOrderSubmit").disabled = !hasAvailableProducts;
  lines.querySelectorAll("select, input, button").forEach((control) => {
    control.disabled = !hasAvailableProducts;
  });
  $("[data-add-quick-order-line]").disabled = !hasAvailableProducts;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast-message";
  toast.textContent = message;
  $("#toastRegion").appendChild(toast);

  window.setTimeout(() => toast.remove(), 3500);
}

function showNotice(title, message) {
  $("#noticeTitle").textContent = title;
  $("#noticeMessage").textContent = message;
  $("#noticeOverlay").hidden = false;
}

function closeCart() {
  $("#cartOverlay").hidden = true;
}

function closeNotice() {
  $("#noticeOverlay").hidden = true;
}

function setAuthMode(mode) {
  state.authMode = mode;
  $("#authTitle").textContent = mode === "register" ? "Create your account" : "Sign in";
  $("#authDescription").textContent = mode === "register"
    ? "Create your business profile. All accounts can buy; supplier access requires admin approval."
    : "Sign in to place orders and join group deals.";
  $("#authNameField").hidden = mode !== "register";
  $("#authPhoneField").hidden = mode !== "register";
  $("#authTermsField").hidden = mode !== "register";
  $("#businessRegistrationFields").hidden = mode !== "register";
  $("#authForm").closest(".auth-dialog")
    .classList.toggle("is-business-registration", mode === "register");
  $("#authForm").elements.namedItem("terms_accepted").required = mode === "register";
  $("#authForm").elements.namedItem("name").required = mode === "register";
  $("#authForm").elements.namedItem("phone").required = mode === "register";
  [
    "legal_business_name", "business_name", "business_registration_number",
    "business_structure", "registered_office_address", "shipping_address",
    "tax_pin_number", "signatory_id_number", "industry_category",
    "monthly_purchase_volume", "preferred_payment_method"
  ].forEach((name) => {
    $("#authForm").elements.namedItem(name).required = mode === "register";
  });
  $("#authForm").elements.namedItem("password").autocomplete =
    mode === "register" ? "new-password" : "current-password";
  $("#authForm").elements.namedItem("password").type = "password";
  $("#togglePasswordVisibility").setAttribute("aria-label", "Show password");
  $("#togglePasswordVisibility").setAttribute("aria-pressed", "false");
  $("#togglePasswordVisibility").title = "Show password";
  $("#togglePasswordVisibility i").className = "fas fa-eye";
  $("#authSubmit").textContent = mode === "register" ? "Create account" : "Sign in";
  $("#authSwitchPrompt").textContent =
    mode === "register" ? "Already have an account?" : "New to TradeCircle?";
  $("#authSwitchButton").textContent =
    mode === "register" ? "Sign in" : "Create an account";
  $("#authError").hidden = true;
  $("#authError").textContent = "";
}

function openAuth(mode = "login") {
  setAuthMode(mode);
  $("#authOverlay").hidden = false;
}

async function restoreSession() {
  try {
    const result = await apiRequest("/auth/me");
    state.user = result.user;
    state.dashboardMode = "buying";
    if (state.user.terms_accepted_version !== CURRENT_TERMS_VERSION) {
      showTermsConsent();
    } else if (["admin", "sales"].includes(state.user.role)) {
      showDashboard();
    } else {
      await loadWishlist();
    }
  } catch (error) {
    if (error.status !== 401) {
      showToast(`Unable to restore your sign-in: ${error.message}`);
    }
  }
  updateAccountButton();
}

function showTermsConsent() {
  $("#termsConsentForm").reset();
  $("#termsConsentError").hidden = true;
  $("#termsConsentOverlay").hidden = false;
}

function updateAccountButton() {
  $("#dashboardLink").hidden = !state.user;
  $("#navGetStartedButton").hidden = Boolean(state.user);
  const isAdmin = state.user?.role === "admin";
  const isInternalAccount = isAdmin || state.user?.role === "sales";
  document.body.classList.toggle("is-admin-account", isAdmin);
  $("#cartNavItem").hidden = isInternalAccount;
  $("#mobileCartButton").hidden = isInternalAccount;
  if (isInternalAccount) {
    state.cart = {};
    renderCart();
    $("#cartOverlay").hidden = true;
  }
  renderProducts();
  renderDeals();
}

async function signOut() {
  clearInterval(adminActivityTimer);
  adminActivityTimer = null;
  try {
    await apiRequest("/auth/logout", { method: "POST" });
  } catch (error) {
    if (error.status !== 401) {
      showToast(error.message);
      return;
    }
  }

  state.user = null;
  state.dashboardMode = "buying";
  state.wishlist.clear();
  state.showWishlistOnly = false;
  $("#savedProductsFilter").classList.remove("active");
  renderProducts();
  $("#dashboard").hidden = true;
  $("#adminDetailOverlay").hidden = true;
  document.body.classList.remove("is-dashboard-view");
  document.body.classList.remove("is-admin-console");
  document.body.classList.remove("is-sales-console");
  $("#termsConsentOverlay").hidden = true;
  updateAccountButton();
  showToast("You have signed out.");
}

async function applySupplierAccess(form) {
  const button = $("#supplierApplicationButton");
  const values = new FormData(form);
  button.disabled = true;
  try {
    const result = await apiRequest("/auth/apply-supplier", {
      method: "POST",
      body: JSON.stringify({
        business_name: values.get("business_name"),
        application_note: values.get("application_note")
      })
    });
    state.user = result.user;
    state.dashboardMode = "buying";
    updateAccountButton();
    showDashboard();
    showToast("Supplier application submitted. You can continue buying while an admin reviews it.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = state.user?.supplier_application_status === "pending";
  }
}

function dashboardViewsForRole(role) {
  if (role === "sales") {
    return [
      { key: "overview", label: "Overview", icon: "fa-chart-line" },
      { key: "products", label: "Products", icon: "fa-boxes-stacked" },
      { key: "clients", label: "Clients", icon: "fa-users" },
      { key: "follow-ups", label: "Follow-ups", icon: "fa-phone" },
      { key: "rfqs", label: "RFQs & quotes", icon: "fa-file-invoice-dollar" },
      { key: "account", label: "Account settings", icon: "fa-user-gear" }
    ];
  }
  if ((role === "buyer_supplier" || role === "supplier") &&
      userHasRole("supplier") && state.dashboardMode === "buying") {
    return [
      { key: "overview", label: "Overview", icon: "fa-store" },
      { key: "orders", label: "My purchases", icon: "fa-receipt" },
      { key: "account", label: "Account settings", icon: "fa-user-gear" }
    ];
  }
  if ((role === "supplier" || role === "buyer_supplier") &&
      userHasRole("supplier") && state.dashboardMode === "selling") {
    return [
      { key: "overview", label: "Overview", icon: "fa-chart-pie" },
      { key: "products", label: "Products", icon: "fa-boxes-stacked" },
      { key: "orders", label: "Orders", icon: "fa-receipt" },
      { key: "account", label: "Account settings", icon: "fa-user-gear" }
    ];
  }
  if (role === "buyer" || (role === "supplier" && !userHasRole("supplier"))) {
    return [
      { key: "overview", label: "Overview", icon: "fa-store" },
      { key: "orders", label: "Orders", icon: "fa-receipt" },
      { key: "account", label: "Account settings", icon: "fa-user-gear" }
    ];
  }
  if (role === "admin") {
    return [
      { key: "overview", label: "Overview", icon: "fa-chart-pie", group: "Overview" },
      { key: "activity", label: "Activity feed", icon: "fa-wave-square", group: "Overview" },
      { key: "wholesale-revenue", label: "Wholesale revenue", icon: "fa-chart-column", group: "Business intelligence" },
      { key: "supply-chain", label: "Supply chain forecast", icon: "fa-boxes-stacked", group: "Business intelligence" },
      { key: "client-funnel", label: "Client acquisition", icon: "fa-filter", group: "Business intelligence" },
      { key: "system-integrations", label: "System & ERP monitors", icon: "fa-plug", group: "Business intelligence" },
      { key: "accounts", label: "Buyers & suppliers", icon: "fa-users", group: "Marketplace" },
      { key: "suppliers", label: "Supplier verification", icon: "fa-shield-halved", group: "Marketplace" },
      { key: "approvals", label: "Product approvals", icon: "fa-clipboard-check", group: "Marketplace" },
      { key: "deal-requests", label: "Deal approvals", icon: "fa-people-group", group: "Marketplace" },
      { key: "listings", label: "Published listings", icon: "fa-boxes-stacked", group: "Marketplace" },
      { key: "group-buying", label: "Group buying", icon: "fa-people-group", group: "Marketplace" },
      { key: "orders", label: "Orders & delivery", icon: "fa-truck-fast", group: "Transactions" },
      { key: "payments", label: "Supplier payments", icon: "fa-money-bill-transfer", group: "Transactions" },
      { key: "preview", label: "Safe previews", icon: "fa-eye", group: "Administration" },
      { key: "account", label: "Account settings", icon: "fa-user-gear", group: "Administration" }
    ];
  }
  return [];
}

function adminViewFromHash() {
  const match = window.location.hash.match(/^#admin\/([a-z-]+)$/);
  return match ? match[1] : "overview";
}

function setDashboardView(view, updateLocation = true) {
  const activeContainers = [...document.querySelectorAll(
    "#buyerDashboard, #sellerDashboard, #salesDashboard, #adminDashboard"
  )].filter((container) => !container.hidden);
  if (!activeContainers.length) return;

  const views = dashboardViewsForRole(state.user.role);
  const selectedView = views.some((item) => item.key === view) ? view : "overview";
  activeContainers.forEach((container) => {
    container.querySelectorAll("[data-dashboard-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.dashboardPanel !== selectedView;
    });
  });
  $("#accountSettingsPanel").hidden = selectedView !== "account";
  $("#dashboardNav").querySelectorAll("[data-dashboard-view]").forEach((button) => {
    const active = button.dataset.dashboardView === selectedView;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (state.user.role === "admin" && selectedView === "preview") {
    void renderAdminPreview();
  }
  if (state.user.role === "admin") {
    const nextHash = `#admin/${selectedView}`;
    if (updateLocation && window.location.hash !== nextHash) {
      window.history.pushState({ adminView: selectedView }, "", nextHash);
    }
    const visiblePanel = selectedView === "account"
      ? $("#accountSettingsPanel")
      : [...activeContainers[0].querySelectorAll("[data-dashboard-panel]")]
        .find((panel) => panel.dataset.dashboardPanel === selectedView);
    visiblePanel?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderDashboardNav() {
  const role = state.user.role;
  const accountName = role === "admin" ? "TradeCircle Admin" : state.user.name;
  const roleLabels = {
    buyer: "Buyer",
    supplier: "Supplier",
    buyer_supplier: "Buyer & Supplier",
    sales: "Sales & Account Management",
    admin: "Admin"
  };
  $("#dashboardModeControls").hidden = !userHasRole("supplier");
  $("#dashboardModeControls").querySelectorAll("[data-dashboard-mode]").forEach((button) => {
    const active = button.dataset.dashboardMode === state.dashboardMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#dashboardAccountName").textContent = accountName;
  $("#dashboardAccountRole").textContent = userHasRole("supplier")
    ? "Buyer & Supplier"
    : roleLabels[role] || "Account";
  $("#dashboardWorkspaceLabel").textContent =
    role === "admin" ? "ADMIN CONTROL CENTER"
      : role === "sales" ? "SALES WORKSPACE" : "WORKSPACE";
  $("#dashboardAvatar").textContent = accountName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  let previousGroup = "";
  $("#dashboardNav").innerHTML = `
    ${dashboardViewsForRole(role).map((view, index) => {
      const groupLabel = view.group && view.group !== previousGroup
        ? `<span class="dashboard-nav-group-label">${escapeHTML(view.group)}</span>`
        : "";
      previousGroup = view.group || "";
      return `${groupLabel}
        <button class="dashboard-nav-button ${index === 0 ? "is-active" : ""}" type="button" data-dashboard-view="${view.key}" ${index === 0 ? 'aria-current="page"' : ""}>
          <i class="fas ${view.icon}" aria-hidden="true"></i>${escapeHTML(view.label)}
        </button>`;
    }).join("")}
    ${role === "sales" ? "" : '<a class="dashboard-nav-button" href="#products"><i class="fas fa-compass" aria-hidden="true"></i>Discover products</a>'}
    <button class="dashboard-nav-button" type="button" data-dashboard-sign-out>
      <i class="fas fa-arrow-right-from-bracket" aria-hidden="true"></i>Sign out
    </button>
  `;
}

function showDashboard() {
  if (!state.user) {
    openAuth();
    return;
  }

  document.body.classList.add("is-dashboard-view");
  document.body.classList.toggle("is-admin-console", state.user.role === "admin");
  document.body.classList.toggle("is-sales-console", state.user.role === "sales");
  $("#dashboard").hidden = false;
  const dashboardTitles = {
    buyer: "Buyer dashboard",
    supplier: "Supplier dashboard",
    buyer_supplier: "Buyer & supplier dashboard",
    sales: "Sales & account management",
    admin: "Admin dashboard"
  };
  const isAdmin = state.user.role === "admin";
  const isSales = state.user.role === "sales";
  if (!isAdmin && window.location.hash.startsWith("#admin/")) {
    window.history.replaceState(null, "", "#dashboard");
  }
  if (isAdmin) {
    clearInterval(adminActivityTimer);
    adminActivityTimer = window.setInterval(() => void loadDashboard(), 30000);
  } else {
    clearInterval(adminActivityTimer);
    adminActivityTimer = null;
  }
  const isSupplier = userHasRole("supplier");
  const isBuyer = userHasRole("buyer");
  const accountName = isAdmin ? "TradeCircle Admin" : state.user.name;
  $("#dashboard").classList.toggle("is-admin-dashboard", isAdmin);
  $("#dashboard").classList.toggle("is-sales-dashboard", isSales);
  $("#dashboard").classList.toggle(
    "is-supplier-dashboard",
    isSupplier && state.dashboardMode === "selling"
  );
  $("#dashboardEyebrow").textContent = isAdmin
    ? "MARKETPLACE OPERATIONS"
    : isSales ? "SALES & ACCOUNT MANAGEMENT" : "YOUR TRADECIRCLE";
  $("#dashboardTitle").textContent = isAdmin
    ? "Admin control room"
    : isSales
      ? "Sales & account management"
    : isSupplier
      ? `${state.dashboardMode === "selling" ? "Supplier" : "Buyer"} dashboard`
      : dashboardTitles[state.user.role] || "Dashboard";
  $("#dashboardDescription").textContent = isAdmin
    ? `Welcome, ${accountName}. Review and manage the TradeCircle marketplace.`
    : isSales
      ? `Welcome, ${state.user.name}. Manage buyer relationships and account follow-ups.`
    : `Welcome, ${state.user.name}. Manage your TradeCircle account here.`;
  $("#buyerDashboard").hidden = !isBuyer || (isSupplier && state.dashboardMode !== "buying");
  $("#sellerDashboard").hidden = !isSupplier || state.dashboardMode !== "selling";
  $("#salesDashboard").hidden = !isSales;
  $("#adminDashboard").hidden = state.user.role !== "admin";
  const applicationCard = $("#supplierApplicationCard");
  const applicationStatus = state.user.supplier_application_status || "none";
  applicationCard.hidden = isAdmin || applicationStatus === "approved";
  $("#supplierApplicationStatus").textContent = applicationStatus === "pending"
    ? "Your application is with the admin team. You can keep buying while it is reviewed."
    : applicationStatus === "rejected"
      ? "Your previous application was not approved. Update your business details and apply again."
      : "Your buyer account can apply for selling access. An admin must approve your business before supplier tools are enabled.";
  $("#supplierApplicationButton").disabled = applicationStatus === "pending";
  $("#supplierApplicationButton").textContent = applicationStatus === "pending"
    ? "Application pending"
    : applicationStatus === "rejected"
      ? "Apply again"
      : "Submit supplier application";
  $("#supplierApplicationForm").querySelectorAll("input, textarea, button")
    .forEach((control) => { control.disabled = applicationStatus === "pending"; });
  $("#sellerWelcome").textContent = state.user.name;
  renderDashboardNav();
  setDashboardView(isAdmin ? adminViewFromHash() : "overview");
  $("#dashboardError").hidden = true;
  $("#dashboard").scrollIntoView({ behavior: "smooth" });
  void loadDashboard();
}

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function statusLabel(status) {
  return escapeHTML(String(status || "pending").replaceAll("_", " "));
}

function paymentMethodLabel(method) {
  return ({
    mpesa: "M-Pesa",
    bank_transfer: "Bank transfer",
    card: "Card",
    cash: "Cash / in person",
    other: "Other"
  })[method] || "Payment method";
}

function statusBadge(status) {
  const safeStatus = ["pending", "confirmed", "processing", "shipped", "delivered",
    "cancelled", "paid", "unpaid", "reported", "failed", "active", "completed",
    "approved", "rejected"].includes(status) ? status : "pending";
  return `<span class="status-badge status-${safeStatus}">${statusLabel(status)}</span>`;
}

function renderBuyerOrders(orders) {
  if (!orders.length) {
    $("#buyerOrders").innerHTML = '<p class="dashboard-empty">You have not placed any orders yet.</p>';
    return;
  }
  $("#buyerOrders").innerHTML = orders.map((order) => {
    const items = Array.isArray(order.items) ? order.items : [];
    const supplierPayments = Array.isArray(order.supplier_payments)
      ? order.supplier_payments
      : [];
    return `
      <article class="dashboard-item">
        <div class="dashboard-item-heading">
          <strong>Order #${escapeHTML(order.id)}</strong>
          ${statusBadge(order.status)}
        </div>
        <p>${displayDate(order.created_at)} · Payment: ${statusLabel(order.payment_status)}</p>
        <ul>${items.map((item) => `
          <li>${escapeHTML(item.name)} · ${formatUnits(item.quantity, item.unit_label)}
            · ${formatKES(Number(item.unit_price))} per ${escapeHTML(item.unit_label || "unit")}
            · Total ${formatKES(Number(item.unit_price) * Number(item.quantity))}
            ${item.group_deal_id ? " · Group-buy purchase" : ""}
            · ${statusLabel(item.fulfillment_status)} by ${escapeHTML(item.supplier_name || "supplier")}
          </li>
        `).join("")}</ul>
        <strong>Total: ${formatKES(Number(order.total_amount))}</strong>
        ${supplierPayments.length ? `
          <div class="supplier-payment-list">
            ${supplierPayments.map((payment) => `
              <section class="supplier-payment-card">
                <div class="dashboard-item-heading">
                  <strong>Pay ${escapeHTML(payment.supplier_name)} directly</strong>
                  ${statusBadge(payment.status)}
                </div>
                <p>Supplier total: ${formatKES(Number(payment.amount))}</p>
                <p>Accepted methods: ${payment.payment_methods.map(paymentMethodLabel).join(", ")}</p>
                <p class="supplier-payment-instructions">${escapeHTML(payment.payment_instructions)}</p>
                ${payment.status === "unpaid" ? `
                  <form class="supplier-payment-report"
                        data-supplier-payment-order="${escapeHTML(order.id)}"
                        data-supplier-id="${escapeHTML(payment.supplier_id)}">
                    <label>Payment method used
                      <select name="payment_method" required>
                        <option value="" selected disabled>Choose method</option>
                        ${payment.payment_methods.map((method) => `
                          <option value="${escapeHTML(method)}">${escapeHTML(paymentMethodLabel(method))}</option>
                        `).join("")}
                      </select>
                    </label>
                    <button class="button secondary-button" type="submit">I've sent payment</button>
                  </form>
                ` : payment.status === "reported" ? `
                  <p>Reported as ${escapeHTML(paymentMethodLabel(payment.selected_method))}; waiting for the supplier to confirm receipt.</p>
                ` : payment.selected_method ? `
                  <p>Confirmed paid by ${escapeHTML(paymentMethodLabel(payment.selected_method))}.</p>
                ` : ""}
              </section>
            `).join("")}
          </div>
        ` : order.payment_status !== "paid" ? `
          <form class="mpesa-retry-form" data-retry-payment="${escapeHTML(order.id)}">
            <label>M-Pesa number
              <input name="phone" type="tel" inputmode="tel" autocomplete="tel"
                     placeholder="0712 345 678" pattern="(?:\\+?254|0)?[71][0-9]{8}" required>
            </label>
            <button class="button primary-button" type="submit">
              ${order.payment_status === "pending" ? "Check / continue payment" : "Pay with M-Pesa"}
            </button>
          </form>
        ` : ""}
      </article>`;
  }).join("");
}

function renderSellerProducts(listings) {
  if (!listings.length) {
    $("#sellerProducts").innerHTML = '<p class="dashboard-empty">You have no product listings yet.</p>';
    return;
  }
  $("#sellerProducts").innerHTML = listings.map((product) => `
    <article class="dashboard-item">
      <div class="dashboard-item-heading">
        <strong>${escapeHTML(product.name)}</strong>
        ${statusBadge(product.status)}
      </div>
      <p>${escapeHTML(product.category)} · ${formatKES(Number(product.wholesale_price))} per ${escapeHTML(product.unit_label || "unit")} · Minimum order ${formatUnits(product.minimum_quantity, product.unit_label || "unit")}</p>
      <form class="dashboard-inline-form" data-stock-product="${escapeHTML(product.id)}">
        <label>Stock (${escapeHTML(pluralUnitLabel(product.unit_label))})
          <input name="stock_quantity" type="number" min="0" step="1" value="${escapeHTML(product.stock_quantity)}" required>
        </label>
        <button class="button secondary-button" type="submit">Update stock</button>
      </form>
      ${product.status === "approved" ? `
        <details class="listing-edit">
          <summary>Request a featured group deal</summary>
          <p class="dashboard-help">Your request goes to an admin for review. The deal is not published unless an admin approves it.</p>
          <form class="dashboard-form" data-request-deal="${escapeHTML(product.id)}">
            <label>Target quantity
              <input name="target_quantity" type="number" min="${escapeHTML(product.minimum_quantity)}" step="1" value="${escapeHTML(Math.max(product.minimum_quantity, product.minimum_quantity * 10))}" required>
            </label>
            <label>Deal price per ${escapeHTML(product.unit_label || "unit")} (KES)
              <input name="discounted_price" type="number" min="0" max="${escapeHTML(product.wholesale_price)}" step="0.01" required>
            </label>
            <label>Deal ends
              <input name="ends_at" type="datetime-local" required>
            </label>
            <label class="dashboard-form-wide">Note to admin (optional)
              <textarea name="supplier_note" rows="2" maxlength="1000"></textarea>
            </label>
            <div class="dashboard-form-wide">
              <button class="button secondary-button" type="submit">Send deal request</button>
            </div>
          </form>
        </details>` : ""}
      <details class="listing-edit">
        <summary>Edit listing details</summary>
        <form class="dashboard-form" data-edit-product="${escapeHTML(product.id)}">
          <label>Product name<input name="name" type="text" minlength="2" maxlength="180" value="${escapeHTML(product.name)}" required></label>
          <label>Category<input name="category" type="text" maxlength="100" value="${escapeHTML(product.category)}" required></label>
          <label>Price per package (KES)<input name="wholesale_price" type="number" min="0" step="0.01" value="${escapeHTML(product.wholesale_price)}" required></label>
          <label>Sold as<select name="unit_label" required>${productUnitOptions(product.unit_label || "unit")}</select></label>
          <label>Minimum order (packages)<input name="minimum_quantity" type="number" min="1" step="1" value="${escapeHTML(product.minimum_quantity)}" required></label>
          <label class="dashboard-form-wide">Image URL<input name="image_url" type="url" maxlength="2000" value="${escapeHTML(product.image_url || "")}"></label>
          <label class="dashboard-form-wide">Description<textarea name="description" rows="2" maxlength="5000">${escapeHTML(product.description || "")}</textarea></label>
          <div class="dashboard-form-wide"><button class="button secondary-button" type="submit">Save and resubmit for approval</button></div>
        </form>
      </details>
    </article>
  `).join("");
}

function renderSupplierDealRequests(requests) {
  const target = $("#sellerDealRequests");
  if (!requests.length) {
    target.innerHTML = '<p class="dashboard-empty">You have not requested any featured group deals yet.</p>';
    return;
  }
  target.innerHTML = requests.map((request) => `
    <article class="dashboard-item">
      <div class="dashboard-item-heading">
        <strong>${escapeHTML(request.product_name)}</strong>
        ${statusBadge(request.status)}
      </div>
      <p>Target ${formatUnits(request.target_quantity, request.unit_label)} · Deal price ${formatKES(Number(request.discounted_price))} · Ends ${displayDate(request.ends_at)}</p>
      ${request.supplier_note ? `<p>${escapeHTML(request.supplier_note)}</p>` : ""}
    </article>
  `).join("");
}

function renderSellerOrders(orders, target = "#sellerOrders") {
  if (!orders.length) {
    $(target).innerHTML = '<p class="dashboard-empty">No orders contain your products yet.</p>';
    return;
  }
  const transitions = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["processing", "cancelled"],
    processing: ["shipped", "cancelled"],
    shipped: ["delivered"],
    delivered: [],
    cancelled: []
  };
  $(target).innerHTML = orders.map((order) => {
    const options = [order.fulfillment_status, ...(transitions[order.fulfillment_status] || [])];
    return `
      <article class="dashboard-item">
        <div class="dashboard-item-heading">
          <strong>Order #${escapeHTML(order.order_id)} · ${escapeHTML(order.product_name)}</strong>
          ${statusBadge(order.fulfillment_status)}
        </div>
        <p>${displayDate(order.created_at)} · Buyer: ${escapeHTML(order.buyer_name)} · ${formatUnits(order.quantity, order.unit_label)} × ${formatKES(Number(order.unit_price))} · Supplier payment: ${statusLabel(order.supplier_payment_status || order.payment_status)}${order.supplier_payment_method ? ` (${escapeHTML(paymentMethodLabel(order.supplier_payment_method))})` : ""}</p>
        ${order.supplier_payment_status === "reported" ? `
          <p>Buyer reported ${formatKES(Number(order.supplier_payment_amount))} paid.</p>
          <button class="button secondary-button" type="button"
                  data-confirm-supplier-payment="${escapeHTML(order.supplier_payment_id)}">
            Confirm payment received
          </button>
        ` : ""}
        <label class="dashboard-status-control">Fulfillment
          <select data-order-item-status="${escapeHTML(order.item_id)}">
            ${options.map((status) => `<option value="${escapeHTML(status)}" ${status === order.fulfillment_status ? "selected" : ""}>${statusLabel(status)}</option>`).join("")}
          </select>
        </label>
      </article>`;
  }).join("");
}

function renderPendingProducts(productsToReview) {
  if (!productsToReview.length) {
    $("#adminProducts").innerHTML = '<p class="dashboard-empty">There are no product listings waiting for approval.</p>';
    return;
  }
  $("#adminProducts").innerHTML = productsToReview.map((product) => `
    <article class="dashboard-item">
      <div class="approval-product-image">
        ${product.image_url
          ? `<img src="${escapeHTML(product.image_url)}" alt="${escapeHTML(product.name)}" loading="lazy">`
          : '<span class="product-image-placeholder"><i class="fas fa-box-open" aria-hidden="true"></i></span>'}
      </div>
      <div class="dashboard-item-heading"><strong>${escapeHTML(product.name)}</strong><span>${formatKES(Number(product.wholesale_price))} / ${escapeHTML(product.unit_label || "unit")}</span></div>
      <p>${escapeHTML(product.category)} · Minimum order ${formatUnits(product.minimum_quantity, product.unit_label || "unit")} · Stock ${formatUnits(product.stock_quantity, product.unit_label || "unit")}</p>
      <p>${escapeHTML(product.description || "No description provided.")}</p>
      <p>Supplier: ${escapeHTML(product.supplier_name)} (${escapeHTML(product.supplier_email)})</p>
      <div class="dashboard-actions">
        <button class="button primary-button" data-review-product="${escapeHTML(product.id)}" data-review-status="approved" type="button">Approve</button>
        <button class="button reject-button" data-review-product="${escapeHTML(product.id)}" data-review-status="rejected" type="button">Reject</button>
      </div>
    </article>
  `).join("");
}

function renderSupplierVerification(suppliers) {
  if (!suppliers.length) {
    $("#adminSuppliers").innerHTML =
      '<p class="dashboard-empty">There are no supplier applications awaiting review.</p>';
    return;
  }
  $("#adminSuppliers").innerHTML = suppliers.map((supplier) => `
    <article class="dashboard-item">
      <div class="dashboard-item-heading">
        <strong>${escapeHTML(supplier.business_name || supplier.name)}</strong>
        <span class="status-badge status-pending">Pending review</span>
      </div>
      <p>Applicant: ${escapeHTML(supplier.name)} · ${escapeHTML(supplier.email)}${supplier.phone ? ` · ${escapeHTML(supplier.phone)}` : ""}</p>
      <p>Applied ${displayDate(supplier.created_at)}</p>
      ${supplier.supplier_application_note
        ? `<p>${escapeHTML(supplier.supplier_application_note)}</p>`
        : ""}
      <div class="dashboard-actions">
        <button class="button secondary-button" type="button" data-view-account="${escapeHTML(supplier.id)}">View business profile</button>
        <button class="button primary-button" type="button"
                data-supplier-decision="${escapeHTML(supplier.id)}"
                data-application-status="approved">Approve application</button>
        <button class="button reject-button" type="button"
                data-supplier-decision="${escapeHTML(supplier.id)}"
                data-application-status="rejected">Reject</button>
      </div>
    </article>
  `).join("");
}

function renderAdminDealRequests(requests) {
  if (!requests.length) {
    $("#adminDealRequests").innerHTML =
      '<p class="dashboard-empty">There are no supplier deal requests awaiting review.</p>';
    return;
  }
  $("#adminDealRequests").innerHTML = requests.map((request) => `
    <article class="dashboard-item">
      <div class="dashboard-item-heading">
        <strong>${escapeHTML(request.product_name)}</strong>
        <span>${formatKES(Number(request.discounted_price))} / ${escapeHTML(request.unit_label || "unit")}</span>
      </div>
      <p>${escapeHTML(request.category)} · Regular price ${formatKES(Number(request.wholesale_price))} · Target ${formatUnits(request.target_quantity, request.unit_label || "unit")}</p>
      <p>Supplier: ${escapeHTML(request.supplier_name)} (${escapeHTML(request.supplier_email)})</p>
      <p>Requested ${displayDate(request.created_at)} · Ends ${displayDate(request.ends_at)}</p>
      ${request.supplier_note ? `<p>Supplier note: ${escapeHTML(request.supplier_note)}</p>` : ""}
      <div class="dashboard-actions">
        <button class="button primary-button" type="button"
                data-review-deal="${escapeHTML(request.id)}" data-deal-status="approved">Approve and feature</button>
        <button class="button reject-button" type="button"
                data-review-deal="${escapeHTML(request.id)}" data-deal-status="rejected">Reject request</button>
      </div>
    </article>
  `).join("");
}

function renderAdminApprovedProducts(productsToManage) {
  const target = $("#adminApprovedProducts");
  if (!productsToManage.length) {
    target.innerHTML = '<p class="dashboard-empty">There are no published listings.</p>';
    return;
  }
  target.innerHTML = productsToManage.map((product) => `
    <article class="dashboard-item">
      <div class="dashboard-item-heading">
        <strong>${escapeHTML(product.name)}</strong>
        <span>${formatKES(Number(product.wholesale_price))} / ${escapeHTML(product.unit_label || "unit")}</span>
      </div>
      <p>${escapeHTML(product.category)} · Stock ${formatUnits(product.stock_quantity, product.unit_label || "unit")}</p>
      <p>Supplier: ${escapeHTML(product.supplier_name)} (${escapeHTML(product.supplier_email)})</p>
      <button class="button reject-button" type="button"
              data-remove-product="${escapeHTML(product.id)}">Remove listing from marketplace</button>
    </article>
  `).join("");
}

function renderAdminOverview(summary, pendingProducts, supplierApplications, dealRequests) {
  const pendingCount = Number(summary.pending_products) || 0;
  const approvedCount = Number(summary.approved_products) || 0;
  const dealCount = Number(summary.pending_deal_requests) || 0;
  const supplierCount = supplierApplications.length;
  const totalListings = pendingCount + approvedCount;
  const approvedShare = totalListings ? Math.round((approvedCount / totalListings) * 100) : 0;

  $("#adminModerationTotal").textContent = totalListings;
  $("#adminApprovedLegend").textContent = approvedCount;
  $("#adminPendingLegend").textContent = pendingCount;
  $("#adminDealLegend").textContent = dealCount;
  $("#adminModerationRing").style.setProperty("--approved-share", `${approvedShare}%`);

  const queueCounts = [pendingCount, dealCount, supplierCount];
  const maxQueue = Math.max(...queueCounts, 1);
  const queueRows = [
    ["#adminPendingBarCount", "#adminPendingBar", pendingCount],
    ["#adminDealBarCount", "#adminDealBar", dealCount],
    ["#adminSupplierBarCount", "#adminSupplierBar", supplierCount]
  ];
  queueRows.forEach(([countSelector, barSelector, count]) => {
    $(countSelector).textContent = count;
    $(barSelector).style.width = `${Math.max(count ? 8 : 0, (count / maxQueue) * 100)}%`;
  });

  state.adminOverviewItems = [
    ...pendingProducts.map((product) => ({
      kind: "listing",
      label: "Listing review",
      title: product.name,
      detail: `${product.category} · ${product.supplier_name}`,
      date: product.created_at,
      meta: formatKES(Number(product.wholesale_price)),
      view: "approvals",
      icon: "fa-box"
    })),
    ...dealRequests.map((request) => ({
      kind: "deal",
      label: "Group deal",
      title: request.product_name,
      detail: `Requested by ${request.supplier_name}`,
      date: request.created_at,
      meta: formatKES(Number(request.discounted_price)),
      view: "deal-requests",
      icon: "fa-people-group"
    })),
    ...supplierApplications.map((supplier) => ({
      kind: "supplier",
      label: "Supplier application",
      title: supplier.business_name || supplier.name,
      detail: `Application from ${supplier.name}`,
      date: supplier.created_at,
      meta: "Pending",
      view: "suppliers",
      icon: "fa-store"
    }))
  ].sort((first, second) => new Date(second.date) - new Date(first.date));

  renderAdminOverviewQueue();
}

function renderAdminOverviewQueue() {
  const target = $("#adminOverviewQueue");
  if (!target) return;

  const query = $("#adminQueueSearch").value.trim().toLowerCase();
  const kind = $("#adminQueueFilter").value;
  const items = (state.adminOverviewItems || []).filter((item) => {
    const matchesKind = kind === "all" || item.kind === kind;
    const matchesQuery = !query || `${item.title} ${item.detail} ${item.label}`
      .toLowerCase().includes(query);
    return matchesKind && matchesQuery;
  }).slice(0, 6);

  if (!items.length) {
    target.innerHTML = '<p class="admin-queue-empty">No matching review activity.</p>';
    return;
  }

  target.innerHTML = items.map((item) => `
    <button class="admin-queue-item" type="button" data-open-dashboard-view="${item.view}">
      <span class="admin-queue-icon is-${item.kind}"><i class="fas ${item.icon}" aria-hidden="true"></i></span>
      <span class="admin-queue-copy"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.label)} · ${escapeHTML(item.detail)}</small></span>
      <span class="admin-queue-meta"><strong>${escapeHTML(item.meta)}</strong><small>${displayDate(item.date)}</small></span>
      <i class="fas fa-chevron-right admin-queue-chevron" aria-hidden="true"></i>
    </button>
  `).join("");
}

function renderAdminBusinessMetrics(metrics) {
  const revenue = metrics.revenue || {};
  const monthlyRevenue = metrics.monthly_revenue || [];
  const funnel = metrics.funnel || {};
  const inventory = metrics.inventory || {};
  const forecast = metrics.inventory_forecast || [];
  const paymentHealth = metrics.payment_health || {};
  const number = (value) => Number(value) || 0;
  const formatCount = (value) => new Intl.NumberFormat("en-KE").format(number(value));

  $("#adminLifetimeRevenue").textContent = formatKES(number(revenue.lifetime_paid_revenue));
  $("#adminRevenue30d").textContent = formatKES(number(revenue.paid_revenue_30d));
  $("#adminPaidTransactionCount").textContent = formatCount(revenue.paid_payment_count);
  $("#adminAverageTransaction").textContent = formatKES(number(revenue.average_paid_payment));

  const recentRevenue = number(revenue.paid_revenue_30d);
  const previousRevenue = number(revenue.paid_revenue_previous_30d);
  $("#adminRevenueChange").textContent = previousRevenue
    ? `${Math.abs(Math.round(((recentRevenue - previousRevenue) / previousRevenue) * 100))}% ${
        recentRevenue >= previousRevenue ? "up" : "down"
      } vs previous 30 days`
    : "No paid revenue in the previous 30 days";

  const maxMonthlyRevenue = Math.max(
    ...monthlyRevenue.map((month) => number(month.revenue)),
    1
  );
  $("#adminRevenueChart").innerHTML = monthlyRevenue.length
    ? monthlyRevenue.map((month) => {
      const monthRevenue = number(month.revenue);
      const width = monthRevenue ? Math.max(3, (monthRevenue / maxMonthlyRevenue) * 100) : 0;
      return `
        <div class="admin-metric-bar">
          <span class="admin-metric-bar-label">${escapeHTML(month.month)}</span>
          <span class="admin-metric-bar-track"><span style="width:${width}%"></span></span>
          <strong>${escapeHTML(formatKES(monthRevenue))}</strong>
        </div>`;
    }).join("")
    : '<p class="dashboard-empty">No monthly revenue records are available.</p>';

  $("#adminInventorySkuCount").textContent = formatCount(inventory.approved_skus);
  $("#adminInventoryInStock").textContent = formatCount(inventory.in_stock_skus);
  $("#adminInventoryBelowMinimum").textContent = formatCount(inventory.below_minimum_skus);
  $("#adminInventoryOutOfStock").textContent = formatCount(inventory.out_of_stock_skus);
  $("#adminInventoryForecast").innerHTML = forecast.length
    ? forecast.map((product) => {
      const stock = number(product.stock_quantity);
      const minimum = number(product.minimum_quantity);
      const coverage = product.estimated_days_on_hand === null
        ? "No recent demand"
        : `${number(product.estimated_days_on_hand).toFixed(1)} days`;
      const stockStatus = stock === 0
        ? '<span class="admin-forecast-status is-critical">Out of stock</span>'
        : stock < minimum
          ? '<span class="admin-forecast-status is-warning">Below buyer MOQ</span>'
          : '<span class="admin-forecast-status is-healthy">Available</span>';
      return `
        <tr>
          <td><strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.supplier_name || "Supplier unavailable")}</small></td>
          <td>${escapeHTML(formatUnits(stock, product.unit_label || "unit"))}</td>
          <td>${escapeHTML(formatUnits(product.units_sold_30d, product.unit_label || "unit"))}</td>
          <td>${escapeHTML(coverage)}</td>
          <td>${stockStatus}</td>
        </tr>`;
    }).join("")
    : '<tr><td colspan="5" class="admin-table-empty">No approved wholesale listings to forecast.</td></tr>';

  const buyerCount = number(funnel.buyer_accounts);
  const orderedCount = number(funnel.buyers_with_orders);
  const paidCount = number(funnel.buyers_with_paid_orders);
  const conversionRate = (count) => buyerCount
    ? `${Math.round((count / buyerCount) * 100)}% of buyer accounts`
    : "No buyer accounts yet";
  $("#adminFunnelBuyers").textContent = formatCount(buyerCount);
  $("#adminNewBuyers30d").textContent = formatCount(funnel.new_buyers_30d);
  $("#adminFunnelOrdered").textContent = formatCount(orderedCount);
  $("#adminFunnelPaid").textContent = formatCount(paidCount);
  $("#adminFunnelOrderRate").textContent = conversionRate(orderedCount);
  $("#adminFunnelPaidRate").textContent = conversionRate(paidCount);

  const funnelStages = [
    { label: "Registered buyer accounts", count: buyerCount },
    { label: "Placed at least one order", count: orderedCount },
    { label: "Completed a payment", count: paidCount }
  ];
  $("#adminClientFunnel").innerHTML = funnelStages.map((stage, index) => {
    const width = buyerCount ? (stage.count / buyerCount) * 100 : 0;
    return `
      <div class="admin-funnel-step">
        <div><span>${index + 1}. ${escapeHTML(stage.label)}</span><strong>${formatCount(stage.count)}</strong></div>
        <span class="admin-funnel-track"><span style="width:${width}%"></span></span>
      </div>`;
  }).join("");

  const totalTransactions = number(paymentHealth.total_transactions);
  const supplierTransactions = number(paymentHealth.supplier_transactions);
  $("#adminPaymentTotal").textContent = formatCount(totalTransactions);
  $("#adminPaymentPaid").textContent = formatCount(paymentHealth.paid_transactions);
  $("#adminPaymentPending").textContent = formatCount(paymentHealth.pending_transactions);
  $("#adminPaymentUnpaid").textContent = formatCount(paymentHealth.unpaid_transactions);
  $("#adminPaymentSupplier").textContent = formatCount(supplierTransactions);

  const supplierPaymentsStatus = $("#adminSupplierPaymentsStatus");
  supplierPaymentsStatus.textContent = supplierTransactions ? "Tracking active" : "No supplier orders";
  supplierPaymentsStatus.className =
    `admin-integration-status ${supplierTransactions ? "is-healthy" : "is-warning"}`;
  $("#adminSupplierPaymentsDetail").textContent =
    `${formatCount(paymentHealth.paid_transactions)} paid · ` +
    `${formatCount(paymentHealth.pending_transactions)} awaiting supplier · ` +
    `${formatCount(paymentHealth.unpaid_transactions)} awaiting buyer`;
  $("#adminApiStatus").textContent = "Healthy";
  $("#adminApiStatus").className = "admin-integration-status is-healthy";
  $("#adminDatabaseStatus").textContent = "Connected";
  $("#adminDatabaseStatus").className = "admin-integration-status is-healthy";
  $("#adminSystemCheckedAt").textContent = `Checked ${new Date().toLocaleTimeString()}`;
}

function renderAdminAccounts(accounts) {
  const target = $("#adminAccounts");
  if (!accounts.length) {
    target.innerHTML = '<p class="admin-queue-empty">No matching accounts found.</p>';
    return;
  }
  target.innerHTML = accounts.map((account) => {
    const isSupplier = account.supplier_verified || account.supplier_application_status !== "none" ||
      ["supplier", "buyer_supplier"].includes(account.role);
    const status = account.role === "sales"
      ? "TradeCircle sales staff"
      : account.supplier_verified
      ? "Verified supplier"
      : account.supplier_application_status === "pending"
        ? "Verification pending"
        : isSupplier ? "Supplier access not verified" : "Buyer account";
    return `
      <button class="admin-data-row" type="button" data-view-account="${escapeHTML(account.id)}">
        <span class="admin-data-avatar">${escapeHTML(account.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase())}</span>
        <span class="admin-data-primary"><strong>${escapeHTML(account.business_name || account.name)}</strong><small>${escapeHTML(account.name)} · ${escapeHTML(account.email)}</small></span>
        <span class="admin-data-secondary"><strong>${escapeHTML(status)}</strong><small>${isSupplier ? `${account.active_product_count} active listings` : `${account.order_count} orders`}</small></span>
        <span class="admin-data-date">Joined ${escapeHTML(displayDate(account.created_at))}</span>
        <i class="fas fa-chevron-right" aria-hidden="true"></i>
      </button>`;
  }).join("");
}

function filterAdminAccounts() {
  const search = $("#adminAccountSearch").value.trim().toLowerCase();
  const kind = $("#adminAccountKind").value;
  const accounts = (state.adminData.accounts || []).filter((account) => {
    const isSupplier = account.supplier_verified || account.supplier_application_status !== "none" ||
      ["supplier", "buyer_supplier"].includes(account.role);
    const matchesKind = kind === "all" ||
      (kind === "suppliers" ? isSupplier
        : kind === "employees" ? account.role === "sales"
          : !isSupplier && account.role !== "sales");
    const matchesSearch = !search || [account.name, account.business_name, account.email]
      .some((value) => String(value || "").toLowerCase().includes(search));
    return matchesKind && matchesSearch;
  });
  renderAdminAccounts(accounts);
}

function renderAdminOrders(orders) {
  const target = $("#adminOrders");
  if (!orders.length) {
    target.innerHTML = '<p class="admin-queue-empty">No orders match these filters.</p>';
    return;
  }
  const stages = ["Placed", "Paid", "Processing", "In transit", "Delivered"];
  target.innerHTML = orders.map((order) => {
    const fulfillment = order.items.map((item) => item.fulfillment_status);
    const stage = [
      true,
      order.payment_status === "paid",
      fulfillment.some((status) => ["confirmed", "processing", "shipped", "delivered"].includes(status)),
      fulfillment.some((status) => ["shipped", "delivered"].includes(status)),
      fulfillment.length > 0 && fulfillment.every((status) => status === "delivered")
    ];
    const itemMarkup = order.items.map((item) => `
      <div class="admin-order-product">
        ${item.image_url ? `<img class="admin-product-thumb" src="${escapeHTML(item.image_url)}" alt="${escapeHTML(item.product_name)}" loading="lazy">` : '<span class="admin-product-thumb admin-product-thumb-empty"><i class="fas fa-box" aria-hidden="true"></i></span>'}
        <button type="button" data-view-product="${escapeHTML(item.product_id)}">${escapeHTML(formatUnits(item.quantity, item.unit_label))} ${escapeHTML(item.product_name)}</button>
        <button type="button" data-view-account="${escapeHTML(item.supplier_id)}">${escapeHTML(item.supplier_name)}</button>
        ${statusBadge(item.fulfillment_status)}
      </div>`).join("");
    return `
      <article class="admin-order-card">
        <header class="admin-order-heading">
          <div><strong>Order #TC-${escapeHTML(order.id)}</strong><small>${escapeHTML(displayDate(order.created_at))}</small></div>
          ${statusBadge(order.status)}
        </header>
        <div class="admin-order-parties"><span>Buyer</span><button type="button" data-view-account="${escapeHTML(order.buyer_id)}">${escapeHTML(order.buyer_name)}</button><span class="admin-order-total">${formatKES(Number(order.total_amount))}</span></div>
        <div class="admin-order-products">${itemMarkup || '<span>No order items recorded.</span>'}</div>
        <div class="admin-order-timeline" aria-label="Order progress">
          ${stages.map((label, index) => `<span class="${stage[index] ? "is-complete" : ""}"><i aria-hidden="true"></i>${label}</span>`).join("")}
        </div>
        <footer class="admin-order-footer">
          <span>Payment ${statusBadge(order.payment_status)}</span>
          ${order.latest_receipt_number ? `<span>Receipt ${escapeHTML(order.latest_receipt_number)}</span>` : ""}
          <button type="button" class="admin-inline-link" data-open-payment-order="${escapeHTML(order.id)}">View payment record <i class="fas fa-arrow-right" aria-hidden="true"></i></button>
        </footer>
      </article>`;
  }).join("");
}

function filterAdminOrders() {
  const search = $("#adminOrderSearch").value.trim().toLowerCase();
  const status = $("#adminOrderStatus").value;
  const payment = $("#adminOrderPayment").value;
  const orders = (state.adminData.orders || []).filter((order) => {
    const searchable = `${order.id} ${order.buyer_name} ${order.buyer_email} ${order.items
      .map((item) => `${item.product_name} ${item.supplier_name}`).join(" ")}`.toLowerCase();
    return (!search || searchable.includes(search)) &&
      (status === "all" || order.status === status) &&
      (payment === "all" || order.payment_status === payment);
  });
  renderAdminOrders(orders);
}

function renderAdminPayments(payments) {
  const target = $("#adminPayments");
  if (!payments.length) {
    target.innerHTML = '<p class="admin-queue-empty">No payment records match this filter.</p>';
    return;
  }
  target.innerHTML = payments.map((payment) => `
    <article class="admin-data-row admin-payment-row">
      <span class="admin-payment-icon"><i class="fas fa-money-bill-transfer" aria-hidden="true"></i></span>
      <span class="admin-data-primary"><strong>Order #TC-${escapeHTML(payment.order_id)}</strong><small>${escapeHTML(payment.buyer_name)} · ${escapeHTML(payment.buyer_email)}${payment.supplier_name ? ` · Supplier: ${escapeHTML(payment.supplier_name)}` : ""}</small></span>
      <span class="admin-data-secondary"><strong>${formatKES(Number(payment.amount))}</strong><small>${escapeHTML(payment.provider === "supplier"
        ? payment.selected_method ? paymentMethodLabel(payment.selected_method) : "Direct · method not reported"
        : payment.provider.toUpperCase())}</small></span>
      <span>${statusBadge(payment.status)}</span>
      <span class="admin-data-date">${payment.receipt_number
        ? `Receipt ${escapeHTML(payment.receipt_number)}`
        : payment.provider === "supplier" ? "Supplier confirmation tracking" : "No receipt recorded"}<small>${escapeHTML(displayDate(payment.created_at))}</small></span>
      <button type="button" class="admin-inline-link" data-open-order="${escapeHTML(payment.order_id)}">View order</button>
    </article>`).join("");
}

function renderAdminGroupDeals(deals) {
  const target = $("#adminGroupDeals");
  if (!deals.length) {
    target.innerHTML = '<p class="admin-queue-empty">No group deals match this filter.</p>';
    return;
  }
  target.innerHTML = deals.map((deal) => {
    const targetQuantity = Number(deal.target_quantity) || 0;
    const currentQuantity = Number(deal.current_quantity) || 0;
    const progress = targetQuantity ? Math.min(100, Math.round(currentQuantity / targetQuantity * 100)) : 0;
    return `
      <article class="admin-deal-card">
        <div class="admin-deal-heading">${deal.image_url ? `<img class="admin-product-thumb admin-deal-thumb" src="${escapeHTML(deal.image_url)}" alt="${escapeHTML(deal.product_name)}" loading="lazy">` : '<span class="admin-product-thumb admin-deal-thumb admin-product-thumb-empty"><i class="fas fa-box" aria-hidden="true"></i></span>'}<div><strong>${escapeHTML(deal.product_name)}</strong><small>Deal #GB-${escapeHTML(deal.id)} · Supplier <button type="button" data-view-account="${escapeHTML(deal.supplier_id)}">${escapeHTML(deal.supplier_name)}</button></small></div>${statusBadge(deal.status)}</div>
        <div class="admin-deal-stats"><span><small>Target</small><strong>${escapeHTML(formatUnits(targetQuantity, deal.unit_label))}</strong></span><span><small>Joined</small><strong>${escapeHTML(formatUnits(currentQuantity, deal.unit_label))}</strong></span><span><small>Participants</small><strong>${escapeHTML(deal.participant_count)}</strong></span><span><small>Deal price</small><strong>${formatKES(Number(deal.discounted_price))}</strong></span><span><small>Regular price</small><strong>${formatKES(Number(deal.wholesale_price))}</strong></span></div>
        <div class="admin-deal-progress"><span><span style="width:${progress}%"></span></span><strong>${progress}%</strong></div>
        <div class="admin-deal-footer"><span>${deal.ends_at ? `Ends ${escapeHTML(displayDate(deal.ends_at))}` : "No end date"}</span><details><summary>${deal.participant_count} participants</summary><ul>${(deal.participants || []).map((participant) => `<li><button type="button" data-view-account="${escapeHTML(participant.id)}">${escapeHTML(participant.business_name || participant.name)}</button> · ${escapeHTML(formatUnits(participant.quantity, deal.unit_label))}</li>`).join("") || "<li>No participants recorded.</li>"}</ul></details></div>
      </article>`;
  }).join("");
}

function filterAdminGroupDeals() {
  const status = $("#adminDealStatus").value;
  renderAdminGroupDeals((state.adminData.groupDeals || []).filter((deal) =>
    status === "all" || deal.status === status
  ));
}

function filterAdminPayments() {
  const status = $("#adminPaymentStatus").value;
  const orderId = state.adminData.paymentOrderId;
  renderAdminPayments((state.adminData.payments || []).filter((payment) =>
    (status === "all" || payment.status === status) &&
    (!orderId || String(payment.order_id) === String(orderId))
  ));
}

function renderAdminActivity(activity) {
  const target = $("#adminActivityFeed");
  if (!activity.length) {
    target.innerHTML = '<p class="admin-queue-empty">No activity has been recorded yet.</p>';
    return;
  }
  target.innerHTML = activity.map((item) => `
    <article class="admin-activity-row">
      <span class="admin-activity-icon is-${escapeHTML(item.kind)}"><i class="fas ${item.kind === "payment" ? "fa-money-bill-transfer" : item.kind === "order" ? "fa-box" : item.kind === "deal" ? "fa-people-group" : item.kind === "listing" ? "fa-clipboard-check" : "fa-user-plus"}" aria-hidden="true"></i></span>
      <span class="admin-data-primary"><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.detail)}</small></span>
      ${statusBadge(item.status)}
      <time class="admin-data-date" datetime="${escapeHTML(item.created_at)}">${escapeHTML(displayDate(item.created_at))}</time>
    </article>`).join("");
}

async function openAdminAccount(accountId) {
  const overlay = $("#adminDetailOverlay");
  const content = $("#adminDetailContent");
  content.innerHTML = '<p class="admin-queue-empty">Loading connected account data...</p>';
  overlay.hidden = false;
  try {
    const result = await apiRequest(`/admin/accounts/${encodeURIComponent(accountId)}`);
    const account = result.account;
    const orders = result.buyer.orders || [];
    const productsForSupplier = result.supplier.products || [];
    const businessProfile = account.business_profile || {};
    const businessDetails = [
      ["Legal business name", businessProfile.legal_business_name],
      ["Trading name", businessProfile.business_name],
      ["Registration number", businessProfile.business_registration_number],
      ["Business structure", businessProfile.business_structure],
      ["Business website", businessProfile.company_website],
      ["Registered office", businessProfile.registered_office_address],
      ["Primary / shipping address", businessProfile.shipping_address],
      ["Tax PIN", businessProfile.tax_pin_number],
      ["VAT registered", typeof businessProfile.vat_registered === "boolean" ? businessProfile.vat_registered ? "Yes" : "No" : null],
      ["Signatory ID / passport", businessProfile.signatory_id_number],
      ["Industry", businessProfile.industry_category],
      ["Monthly purchase volume", businessProfile.monthly_purchase_volume],
      ["Preferred payment", businessProfile.preferred_payment_method],
      ["Trade credit requested", typeof businessProfile.trade_credit_requested === "boolean" ? businessProfile.trade_credit_requested ? "Yes" : "No" : null]
    ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
    content.innerHTML = `
      <span class="eyebrow">CONNECTED ACCOUNT</span>
      <h2 id="adminDetailTitle">${escapeHTML(account.business_name || account.name)}</h2>
      <p class="admin-profile-contact">${escapeHTML(account.name)} · ${escapeHTML(account.email)}${account.phone ? ` · ${escapeHTML(account.phone)}` : ""}</p>
      <div class="admin-profile-status">${account.supplier_verified ? '<span class="admin-verified-mark"><i class="fas fa-check" aria-hidden="true"></i> Verified supplier</span>' : `<span>${escapeHTML(account.supplier_application_status.replaceAll("_", " "))}</span>`}<span>Joined ${escapeHTML(displayDate(account.created_at))}</span></div>
      ${["buyer", "sales"].includes(account.role) && !account.supplier_verified && account.supplier_application_status === "none"
        ? `<section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Employee access</h3></div><p class="admin-profile-empty">Sales staff can view all buyer contacts, order and payment history. Granting access changes this account from buyer to internal sales staff; revoking it restores buyer access.</p><button class="button ${account.role === "sales" ? "reject-button" : "primary-button"}" type="button" data-sales-access-account="${escapeHTML(account.id)}" data-sales-access-enabled="${account.role !== "sales"}">${account.role === "sales" ? "Revoke sales access" : "Grant sales access"}</button></section>`
        : ""}
      ${account.supplier_application_note ? `<p class="admin-profile-note">${escapeHTML(account.supplier_application_note)}</p>` : ""}
      <section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Business registration</h3></div>${businessDetails.length ? `<dl class="admin-business-details">${businessDetails.map(([label, value]) => `<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join("")}</dl>` : '<p class="admin-profile-empty">No business registration profile is on file.</p>'}<p class="admin-profile-empty">Uploaded certificates and identity documents are not collected until private document storage is configured.</p></section>
      <div class="admin-profile-metrics"><div><strong>${escapeHTML(result.buyer.order_count)}</strong><span>buyer orders</span></div><div><strong>${escapeHTML(result.buyer.open_orders)}</strong><span>open purchases</span></div><div><strong>${escapeHTML(result.buyer.group_deals.length)}</strong><span>group purchases</span></div><div><strong>${escapeHTML(result.supplier.active_products)}</strong><span>active products</span></div><div><strong>${escapeHTML(result.supplier.open_orders)}</strong><span>supplier open orders</span></div><div><strong>${formatKES(Number(result.supplier.paid_sales))}</strong><span>supplier sales paid</span></div></div>
      <section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Purchase history</h3><span>${formatKES(Number(result.buyer.paid_total))} paid</span></div>${orders.length ? orders.map((order) => `<button class="admin-profile-order" type="button" data-open-order="${escapeHTML(order.id)}"><span><strong>Order #TC-${escapeHTML(order.id)}</strong><small>${escapeHTML(displayDate(order.created_at))} · ${order.items.length} items</small></span><span>${formatKES(Number(order.total_amount))}${statusBadge(order.status)}</span></button>`).join("") : '<p class="admin-profile-empty">No purchases recorded.</p>'}</section>
      <section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Buyer group purchases</h3><span>${result.buyer.group_deals.length} participations</span></div>${result.buyer.group_deals.length ? result.buyer.group_deals.map((deal) => `<div class="admin-profile-product"><span><strong>${escapeHTML(deal.product_name)}</strong><small>Deal #GB-${escapeHTML(deal.id)} · ${escapeHTML(formatUnits(deal.quantity, deal.unit_label))} joined · ${escapeHTML(deal.supplier_name)}</small></span>${statusBadge(deal.status)}</div>`).join("") : '<p class="admin-profile-empty">No group purchases recorded.</p>'}</section>
      <section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Supplier listings</h3><span>${productsForSupplier.length} records</span></div>${productsForSupplier.length ? productsForSupplier.slice(0, 8).map((product) => `<div class="admin-profile-product">${product.image_url ? `<img class="admin-product-thumb" src="${escapeHTML(product.image_url)}" alt="${escapeHTML(product.name)}" loading="lazy">` : '<span class="admin-product-thumb admin-product-thumb-empty"><i class="fas fa-box" aria-hidden="true"></i></span>'}<span><strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.category)} · ${escapeHTML(formatUnits(product.stock_quantity, product.unit_label))} in stock</small></span><span>${formatKES(Number(product.wholesale_price))}${statusBadge(product.status)}</span></div>`).join("") : '<p class="admin-profile-empty">No supplier listings recorded.</p>'}</section>
      <section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Supplier order items</h3><span>${result.supplier.orders.length} recent items</span></div>${result.supplier.orders.length ? result.supplier.orders.slice(0, 8).map((order) => `<button class="admin-profile-order" type="button" data-open-order="${escapeHTML(order.order_id)}"><span><strong>${escapeHTML(order.product_name)}</strong><small>Order #TC-${escapeHTML(order.order_id)} · ${escapeHTML(order.buyer_name)} · ${escapeHTML(formatUnits(order.quantity, order.unit_label))}</small></span><span>${statusBadge(order.fulfillment_status)}</span></button>`).join("") : '<p class="admin-profile-empty">No supplier orders recorded.</p>'}</section>
      <section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Supplier group deals</h3><span>${result.supplier.group_deals.length} deals</span></div>${result.supplier.group_deals.length ? result.supplier.group_deals.map((deal) => `<div class="admin-profile-product"><span><strong>${escapeHTML(deal.product_name)}</strong><small>Deal #GB-${escapeHTML(deal.id)} · ${escapeHTML(formatUnits(deal.current_quantity, deal.unit_label))} / ${escapeHTML(formatUnits(deal.target_quantity, deal.unit_label))}</small></span>${statusBadge(deal.status)}</div>`).join("") : '<p class="admin-profile-empty">No supplier group deals recorded.</p>'}</section>
      <div class="admin-profile-actions"><button type="button" class="admin-quiet-button" data-open-dashboard-view="orders">View all orders</button><button type="button" class="admin-quiet-button" data-open-dashboard-view="listings">View marketplace listings</button></div>`;
  } catch (error) {
    content.innerHTML = `<p class="dashboard-error">Unable to load account: ${escapeHTML(error.message)}</p>`;
  }
}

async function updateAdminSalesAccess(button) {
  const accountId = button.dataset.salesAccessAccount;
  const enabled = button.dataset.salesAccessEnabled === "true";
  button.disabled = true;
  try {
    await apiRequest(`/admin/accounts/${encodeURIComponent(accountId)}/sales-access`, {
      method: "PATCH",
      body: JSON.stringify({ enabled })
    });
    showToast(enabled ? "Sales dashboard access granted and recorded." : "Sales dashboard access revoked and recorded.");
    await openAdminAccount(accountId);
    const accountsResult = await apiRequest("/admin/accounts");
    state.adminData.accounts = accountsResult.accounts;
    filterAdminAccounts();
  } catch (error) {
    showToast(`Unable to update employee access: ${error.message}`);
    button.disabled = false;
  }
}

async function openAdminProduct(productId) {
  const overlay = $("#adminDetailOverlay");
  const content = $("#adminDetailContent");
  content.innerHTML = '<p class="admin-queue-empty">Loading product and transaction data...</p>';
  overlay.hidden = false;
  try {
    const result = await apiRequest(`/admin/products/${encodeURIComponent(productId)}`);
    const product = result.product;
    content.innerHTML = `
      <span class="eyebrow">CONNECTED LISTING</span>
      <h2 id="adminDetailTitle">${escapeHTML(product.name)}</h2>
      <p class="admin-profile-contact">${escapeHTML(product.category)} · ${formatKES(Number(product.wholesale_price))} per ${escapeHTML(product.unit_label)}</p>
      ${product.image_url ? `<img class="admin-product-detail-image" src="${escapeHTML(product.image_url)}" alt="${escapeHTML(product.name)}">` : ""}
      <p class="admin-profile-note">${escapeHTML(product.description || "No description provided.")}</p>
      <div class="admin-profile-status">${statusBadge(product.status)}<span>${escapeHTML(formatUnits(product.stock_quantity, product.unit_label))} in stock</span><span>Minimum ${escapeHTML(formatUnits(product.minimum_quantity, product.unit_label))}</span></div>
      <div class="admin-profile-metrics"><div><strong>${escapeHTML(product.order_count)}</strong><span>orders containing product</span></div><div><strong>${formatKES(Number(product.paid_sales))}</strong><span>paid sales</span></div></div>
      <section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Supplier</h3></div><button class="admin-profile-order" type="button" data-view-account="${escapeHTML(product.supplier_id)}"><span><strong>${escapeHTML(product.supplier_name)}</strong><small>${escapeHTML(product.supplier_email)} · ${product.supplier_verified ? "Verified" : "Not verified"}</small></span><i class="fas fa-arrow-right" aria-hidden="true"></i></button></section>
      <section class="admin-profile-section"><div class="admin-profile-section-heading"><h3>Group deals</h3><span>${product.group_deals.length} records</span></div>${product.group_deals.map((deal) => `<div class="admin-profile-product"><span><strong>Deal #GB-${escapeHTML(deal.id)}</strong><small>${escapeHTML(formatUnits(deal.current_quantity, product.unit_label))} / ${escapeHTML(formatUnits(deal.target_quantity, product.unit_label))}</small></span>${statusBadge(deal.status)}</div>`).join("") || '<p class="admin-profile-empty">No group deals for this listing.</p>'}</section>`;
  } catch (error) {
    content.innerHTML = `<p class="dashboard-error">Unable to load product: ${escapeHTML(error.message)}</p>`;
  }
}

async function renderAdminPreview() {
  const target = $("#adminPreviewContent");
  const supplierPicker = $("#adminPreviewSupplier");
  const buttons = $$("[data-admin-preview-mode]");
  buttons.forEach((button) => {
    const active = button.dataset.adminPreviewMode === state.adminPreviewMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (state.adminPreviewMode === "buyer") {
    supplierPicker.hidden = true;
    target.innerHTML = `
      <div class="admin-preview-banner"><span class="eyebrow">BUYER EXPERIENCE</span><h3>Wholesale marketplace</h3><p>Browse available products and current group deals. Checkout and account actions are disabled in preview.</p></div>
      <div class="admin-preview-grid">${products.slice(0, 8).map((product) => `<article class="admin-preview-product">${product.image ? `<img src="${escapeHTML(product.image)}" alt="${escapeHTML(product.name)}" loading="lazy">` : '<span class="admin-preview-placeholder"><i class="fas fa-box" aria-hidden="true"></i></span>'}<strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.category)} · ${escapeHTML(product.supplier)}</small><span>${formatKES(product.price)} / ${escapeHTML(product.unit)}</span><button type="button" disabled>Preview only</button></article>`).join("") || '<p class="admin-queue-empty">No approved products to preview.</p>'}</div>
      <div class="admin-preview-cart"><div><h3>Buyer cart</h3><p>Cart and checkout controls are disabled in this safe preview.</p></div><button type="button" disabled><i class="fas fa-lock" aria-hidden="true"></i> Checkout disabled</button></div>
      <div class="admin-preview-deals"><h3>Group-buy offers</h3>${state.deals.slice(0, 4).map((deal) => `<div><span><strong>${escapeHTML(deal.title)}</strong><small>${escapeHTML(formatUnits(deal.joined, deal.unit))} of ${escapeHTML(formatUnits(deal.target, deal.unit))} joined</small></span><span>${formatKES(deal.price)}</span></div>`).join("") || '<p class="admin-profile-empty">No group deals currently listed.</p>'}</div>`;
    return;
  }

  supplierPicker.hidden = false;
  const suppliers = (state.adminData.accounts || []).filter((account) => account.supplier_verified);
  supplierPicker.innerHTML = suppliers.map((supplier) => `<option value="${escapeHTML(supplier.id)}">${escapeHTML(supplier.business_name || supplier.name)}</option>`).join("");
  if (!suppliers.length) {
    target.innerHTML = '<p class="admin-queue-empty">No verified supplier accounts are available to preview.</p>';
    return;
  }
  const supplierId = supplierPicker.value || String(suppliers[0].id);
  supplierPicker.value = supplierId;
  target.innerHTML = '<p class="admin-queue-empty">Loading supplier workspace preview...</p>';
  try {
    const result = await apiRequest(`/admin/accounts/${encodeURIComponent(supplierId)}`);
    const supplier = result.account;
    target.innerHTML = `
      <div class="admin-preview-banner"><span class="eyebrow">SUPPLIER EXPERIENCE · READ ONLY</span><h3>${escapeHTML(supplier.business_name || supplier.name)}</h3><p>${escapeHTML(supplier.email)} · ${escapeHTML(supplier.supplier_verified ? "Verified supplier" : "Unverified")}</p></div>
      <div class="admin-profile-metrics"><div><strong>${escapeHTML(result.supplier.active_products)}</strong><span>active products</span></div><div><strong>${escapeHTML(result.supplier.open_orders)}</strong><span>open orders</span></div><div><strong>${escapeHTML(result.supplier.paid_orders)}</strong><span>paid orders</span></div><div><strong>${escapeHTML(result.supplier.group_deals.length)}</strong><span>group deals</span></div><div><strong>${formatKES(Number(result.supplier.paid_sales))}</strong><span>paid sales</span></div></div>
      <div class="admin-data-list">${result.supplier.products.map((product) => `<div class="admin-data-row"><span class="admin-data-primary"><strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.category)} · ${escapeHTML(formatUnits(product.stock_quantity, product.unit_label))} in stock</small></span><span>${formatKES(Number(product.wholesale_price))}</span>${statusBadge(product.status)}</div>`).join("") || '<p class="admin-queue-empty">This supplier has no product listings.</p>'}</div>
      <div class="admin-preview-deals"><h3>Recent supplier order items</h3>${result.supplier.orders.slice(0, 5).map((order) => `<div><span><strong>Order #TC-${escapeHTML(order.order_id)} · ${escapeHTML(order.product_name)}</strong><small>${escapeHTML(order.buyer_name)} · ${escapeHTML(formatUnits(order.quantity, order.unit_label))}</small></span>${statusBadge(order.fulfillment_status)}</div>`).join("") || '<p class="admin-profile-empty">No supplier orders yet.</p>'}</div>
      <div class="admin-preview-deals"><h3>Supplier group deals</h3>${result.supplier.group_deals.slice(0, 4).map((deal) => `<div><span><strong>${escapeHTML(deal.product_name)}</strong><small>${escapeHTML(formatUnits(deal.current_quantity, deal.unit_label))} of ${escapeHTML(formatUnits(deal.target_quantity, deal.unit_label))} · ${escapeHTML(deal.participant_count)} participants</small></span>${statusBadge(deal.status)}</div>`).join("") || '<p class="admin-profile-empty">No supplier group deals.</p>'}</div>
      <p class="admin-preview-note"><i class="fas fa-lock" aria-hidden="true"></i> Preview only. Product, inventory, and order controls are disabled.</p>`;
  } catch (error) {
    target.innerHTML = `<p class="dashboard-error">Unable to load supplier preview: ${escapeHTML(error.message)}</p>`;
  }
}

async function loadAdminActivity() {
  if (state.user?.role !== "admin" || $("#dashboard").hidden) return;
  try {
    const result = await apiRequest("/admin/activity");
    state.adminData.activity = result.activity;
    renderAdminActivity(result.activity);
  } catch (error) {
    $("#adminActivityFeed").innerHTML = `<p class="dashboard-error">Unable to load activity: ${escapeHTML(error.message)}</p>`;
  }
}

function renderSalesClientOptions() {
  const options = state.salesData.clients.map((client) => `
    <option value="${escapeHTML(client.id)}">
      ${escapeHTML(client.business_name || client.name)} · ${escapeHTML(client.name)}
    </option>
  `).join("");
  ["#salesFollowupBuyer", "#salesRfqBuyer"].forEach((selector) => {
    const select = $(selector);
    const currentValue = select.value;
    select.innerHTML = `<option value="">Choose a buyer account</option>${options}`;
    if (state.salesData.clients.some((client) => String(client.id) === currentValue)) {
      select.value = currentValue;
    }
    select.disabled = !state.salesData.clients.length;
  });
  $("#salesFollowupForm").querySelector('button[type="submit"]').disabled =
    !state.salesData.clients.length;
  $("#salesRfqForm").querySelector('button[type="submit"]').disabled =
    !state.salesData.clients.length;
}

function renderSalesProducts() {
  const target = $("#salesProducts");
  if (!target) return;

  const search = $("#salesProductSearch").value.trim().toLowerCase();
  const category = $("#salesProductCategory").value;
  const matches = products.filter((product) => {
    const matchesSearch = [
      product.name,
      product.category,
      product.supplier,
      product.description
    ].some((value) => String(value || "").toLowerCase().includes(search));
    return matchesSearch && (category === "all" || product.category === category);
  });

  $("#salesProductCount").textContent =
    `${products.length} approved wholesale ${products.length === 1 ? "product" : "products"}`;
  if (state.productsLoading) {
    target.innerHTML = '<p class="dashboard-empty">Loading approved products…</p>';
    return;
  }
  if (state.productsError) {
    target.innerHTML = `<p class="dashboard-error">${escapeHTML(state.productsError)}</p>`;
    return;
  }
  if (!matches.length) {
    target.innerHTML = '<p class="dashboard-empty">No approved products match these filters.</p>';
    return;
  }

  target.innerHTML = matches.map((product) => `
    <article class="sales-product-card">
      <div class="sales-product-main">
        <strong>${escapeHTML(product.name)}</strong>
        <small>${escapeHTML(product.category)} · ${escapeHTML(product.supplier)}</small>
        ${product.description ? `<p>${escapeHTML(product.description)}</p>` : ""}
      </div>
      <div class="sales-product-detail"><span>Wholesale price</span><strong>${formatKES(product.price)} / ${escapeHTML(product.unit)}</strong></div>
      <div class="sales-product-detail"><span>Minimum order</span><strong>${escapeHTML(formatUnits(product.minOrder, product.unit))}</strong></div>
      <div class="sales-product-detail"><span>Available stock</span><strong>${escapeHTML(formatUnits(product.stock, product.unit))}</strong></div>
    </article>
  `).join("");
}

function updateSalesProductCategories() {
  const select = $("#salesProductCategory");
  if (!select) return;
  const selected = select.value;
  const categories = [...new Set(products.map((product) => product.category))]
    .sort((first, second) => first.localeCompare(second));
  select.innerHTML = `<option value="all">All categories</option>${categories.map((category) =>
    `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`
  ).join("")}`;
  select.value = categories.includes(selected) ? selected : "all";
}

function renderSalesClients() {
  const target = $("#salesClients");
  const query = $("#salesClientSearch").value.trim().toLowerCase();
  const clients = state.salesData.clients.filter((client) =>
    [client.name, client.email, client.business_name]
      .some((value) => String(value || "").toLowerCase().includes(query))
  );
  if (!clients.length) {
    target.innerHTML = '<p class="dashboard-empty">No buyer accounts match this search.</p>';
    return;
  }
  target.innerHTML = clients.map((client) => `
    <article class="sales-client-card">
      <div class="sales-client-copy">
        <strong>${escapeHTML(client.business_name || client.name)}</strong>
        <small>${escapeHTML(client.name)} · ${escapeHTML(client.email)}${client.phone ? ` · ${escapeHTML(client.phone)}` : ""}</small>
        <span>${Number(client.order_count)} orders · ${Number(client.open_orders)} open · ${formatKES(Number(client.paid_total))} paid</span>
      </div>
      <button class="button secondary-button" type="button" data-sales-client="${escapeHTML(client.id)}">View account</button>
    </article>
  `).join("");
}

async function openSalesClient(clientId) {
  const target = $("#salesClientDetail");
  target.hidden = false;
  target.innerHTML = '<p class="dashboard-empty">Loading buyer order and payment history...</p>';
  try {
    const result = await apiRequest(`/sales/clients/${encodeURIComponent(clientId)}`);
    const client = result.client;
    target.innerHTML = `
      <div class="sales-client-detail-heading">
        <div><span class="eyebrow">BUYER ACCOUNT</span><h4>${escapeHTML(client.business_name || client.name)}</h4><p>${escapeHTML(client.name)} · ${escapeHTML(client.email)}${client.phone ? ` · ${escapeHTML(client.phone)}` : ""}</p></div>
        <button class="button secondary-button" type="button" data-close-sales-client>Close</button>
      </div>
      <div class="dashboard-actions">
        <button class="button secondary-button" type="button" data-sales-start-followup="${escapeHTML(client.id)}">Add follow-up</button>
        <button class="button secondary-button" type="button" data-sales-start-rfq="${escapeHTML(client.id)}">Record RFQ</button>
      </div>
      <section class="sales-detail-section"><h5>Order history</h5>
        ${result.orders.length ? result.orders.map((order) => `
          <article class="sales-record-card">
            <div class="sales-record-heading"><strong>Order #TC-${escapeHTML(order.id)}</strong><span>${formatKES(Number(order.total_amount))}</span></div>
            <p>${escapeHTML(displayDate(order.created_at))} · Order ${escapeHTML(order.status)} · Payment ${escapeHTML(order.payment_status)}</p>
            ${(order.items || []).map((item) => `<small>${escapeHTML(formatUnits(item.quantity, item.unit_label))} · ${escapeHTML(item.name)} · ${formatKES(Number(item.unit_price))} each</small>`).join("")}
          </article>`).join("") : '<p class="admin-profile-empty">No orders recorded for this buyer.</p>'}
      </section>
      <section class="sales-detail-section"><h5>Payment history</h5>
        ${result.payments.length ? result.payments.map((payment) => `
          <article class="sales-record-card sales-payment-row"><div><strong>Order #TC-${escapeHTML(payment.order_id)}</strong><small>${escapeHTML(displayDate(payment.created_at))}${payment.supplier_name ? ` · Supplier ${escapeHTML(payment.supplier_name)}` : ""}${payment.receipt_number ? ` · Receipt ${escapeHTML(payment.receipt_number)}` : ""}${payment.selected_method ? ` · ${escapeHTML(paymentMethodLabel(payment.selected_method))}` : ""}</small></div><span>${formatKES(Number(payment.amount))} · ${escapeHTML(payment.status)}</span></article>
        `).join("") : '<p class="admin-profile-empty">No payment records found.</p>'}
      </section>`;
  } catch (error) {
    target.innerHTML = `<p class="dashboard-error">Unable to load buyer history: ${escapeHTML(error.message)}</p>`;
  }
}

function renderSalesFollowups() {
  const target = $("#salesFollowups");
  if (!state.salesData.followups.length) {
    target.innerHTML = '<p class="dashboard-empty">No follow-ups yet. Add a reminder for a buyer above.</p>';
    return;
  }
  target.innerHTML = state.salesData.followups.map((followup) => `
    <article class="sales-record-card">
      <div class="sales-record-heading"><strong>${escapeHTML(followup.title)}</strong><span class="sales-status">${escapeHTML(followup.status)}</span></div>
      <p>${escapeHTML(followup.business_name || followup.buyer_name)}${followup.due_at ? ` · Due ${escapeHTML(displayDate(followup.due_at))}` : ""}</p>
      ${followup.notes ? `<p>${escapeHTML(followup.notes)}</p>` : ""}
      ${followup.status === "open" ? `<button class="button secondary-button" type="button" data-complete-sales-followup="${escapeHTML(followup.id)}">Mark completed</button>` : ""}
    </article>
  `).join("");
}

function renderSalesRfqs() {
  const target = $("#salesRfqList");
  const rfqs = state.salesData.rfqs;
  if (!rfqs.length) {
    target.innerHTML = '<p class="dashboard-empty">No RFQs recorded yet.</p>';
    return;
  }
  target.innerHTML = rfqs.map((rfq) => `
    <article class="sales-record-card">
      <div class="sales-record-heading"><strong>RFQ #${escapeHTML(rfq.id)} · ${escapeHTML(rfq.business_name || rfq.buyer_name)}</strong><span class="sales-status">${escapeHTML(rfq.status)}</span></div>
      <p>${escapeHTML(rfq.requirements)}</p>
      <p>${Number(rfq.quantity).toLocaleString()} requested${rfq.target_price !== null ? ` · Target ${formatKES(Number(rfq.target_price))}` : ""}${rfq.needed_by ? ` · Needed by ${escapeHTML(displayDate(rfq.needed_by))}` : ""}</p>
      ${["open", "quoted"].includes(rfq.status) ? `<div class="sales-rfq-actions"><button class="button secondary-button" type="button" data-sales-rfq-status="${escapeHTML(rfq.id)}" data-next-rfq-status="won">Mark won</button><button class="button reject-button" type="button" data-sales-rfq-status="${escapeHTML(rfq.id)}" data-next-rfq-status="lost">Mark lost</button><button class="button secondary-button" type="button" data-sales-rfq-status="${escapeHTML(rfq.id)}" data-next-rfq-status="cancelled">Cancel RFQ</button></div>` : ""}
      ${(rfq.quotes || []).map((quote) => `
        <div class="sales-quote-row"><span><strong>${formatKES(Number(quote.amount))}</strong> · ${escapeHTML(quote.status)}${quote.valid_until ? ` · Valid until ${escapeHTML(displayDate(quote.valid_until))}` : ""}<small>${quote.terms ? escapeHTML(quote.terms) : "No additional terms"}</small></span><div>${quote.status === "draft" ? `<button class="button secondary-button" type="button" data-sales-quote-status="${escapeHTML(quote.id)}" data-next-quote-status="shared">Mark shared</button>` : ""}${quote.status === "shared" ? `<button class="button secondary-button" type="button" data-sales-quote-status="${escapeHTML(quote.id)}" data-next-quote-status="accepted">Mark accepted</button><button class="button reject-button" type="button" data-sales-quote-status="${escapeHTML(quote.id)}" data-next-quote-status="declined">Mark declined</button>` : ""}</div></div>
      `).join("")}
      <form class="sales-quote-form" data-sales-quote-form="${escapeHTML(rfq.id)}">
        <label>Draft quote (KES)<input name="amount" type="number" min="0.01" step="0.01" required></label>
        <label>Valid until<input name="valid_until" type="date"></label>
        <label>Terms<input name="terms" type="text" maxlength="2000" placeholder="Optional delivery or payment terms"></label>
        <button class="button primary-button" type="submit">Save draft quote</button>
      </form>
    </article>
  `).join("");
}

async function loadSalesDashboard() {
  const [overviewResult, clientsResult, followupsResult, rfqsResult] = await Promise.all([
    apiRequest("/sales/overview"),
    apiRequest("/sales/clients"),
    apiRequest("/sales/followups"),
    apiRequest("/sales/rfqs")
  ]);
  state.salesData.clients = clientsResult.clients;
  state.salesData.followups = followupsResult.followups;
  state.salesData.rfqs = rfqsResult.rfqs;
  $("#salesBuyerCount").textContent = overviewResult.overview.buyer_accounts;
  $("#salesOrderCount").textContent = overviewResult.overview.total_orders;
  $("#salesPaidTotal").textContent = formatKES(Number(overviewResult.overview.verified_payment_total));
  $("#salesFollowupCount").textContent = overviewResult.overview.open_followups;
  updateSalesProductCategories();
  renderSalesProducts();
  renderSalesClientOptions();
  renderSalesClients();
  renderSalesFollowups();
  renderSalesRfqs();
}

async function loadDashboard() {
  if (!state.user) return false;
  const errorMessage = $("#dashboardError");
  errorMessage.hidden = true;

  try {
    if (userHasRole("buyer")) {
      const result = await apiRequest("/orders/mine");
      renderBuyerOrders(result.orders);
      $("#buyerOrderCount").textContent = result.orders.length;
      $("#buyerProductCount").textContent = products.length;
    }
    if (userHasRole("supplier")) {
      const [productsResult, ordersResult, dealRequestsResult, paymentSettingsResult] = await Promise.all([
        apiRequest("/products/mine"),
        apiRequest("/orders/supplier"),
        apiRequest("/deals/requests/mine"),
        apiRequest("/orders/supplier/payment-settings")
      ]);
      renderSellerProducts(productsResult.products);
      renderSupplierDealRequests(dealRequestsResult.requests);
      const verified = productsResult.supplier_verified === true;
      $("#supplierVerificationNotice").hidden = verified;
      $("#sellerProductForm").querySelectorAll("input, select, textarea, button")
        .forEach((control) => { control.disabled = !verified; });
      renderSellerOrders(ordersResult.orders);
      renderSellerOrders(ordersResult.orders.slice(0, 3), "#sellerRecentOrders");
      const paymentSettingsForm = $("#supplierPaymentSettingsForm");
      const acceptedMethods = paymentSettingsResult.settings.payment_methods || [];
      paymentSettingsForm.querySelectorAll('input[name="payment_methods"]')
        .forEach((input) => { input.checked = acceptedMethods.includes(input.value); });
      paymentSettingsForm.elements.namedItem("payment_instructions").value =
        paymentSettingsResult.settings.payment_instructions || "";
      $("#sellerProductCount").textContent = productsResult.products.length;
      $("#sellerPendingCount").textContent = productsResult.products
        .filter((product) => product.status === "pending").length;
      $("#sellerOrderCount").textContent = ordersResult.orders.length;
    }
    if (state.user.role === "sales") {
      await loadSalesDashboard();
    }
    if (state.user.role === "admin") {
      const [productsResult, summaryResult, suppliersResult, dealRequestsResult,
        approvedProductsResult, accountsResult, ordersResult, paymentsResult,
        groupDealsResult, activityResult, businessMetricsResult] = await Promise.all([
        apiRequest("/admin/products/pending"),
        apiRequest("/admin/summary"),
        apiRequest("/admin/suppliers"),
        apiRequest("/admin/deal-requests"),
        apiRequest("/admin/products/approved"),
        apiRequest("/admin/accounts"),
        apiRequest("/admin/orders"),
        apiRequest("/admin/payments"),
        apiRequest("/admin/group-deals"),
        apiRequest("/admin/activity"),
        apiRequest("/admin/business-metrics")
      ]);
      state.adminData.accounts = accountsResult.accounts;
      state.adminData.orders = ordersResult.orders;
      state.adminData.payments = paymentsResult.payments;
      state.adminData.groupDeals = groupDealsResult.deals;
      state.adminData.activity = activityResult.activity;
      renderPendingProducts(productsResult.products);
      renderSupplierVerification(suppliersResult.suppliers);
      renderAdminDealRequests(dealRequestsResult.requests);
      renderAdminApprovedProducts(approvedProductsResult.products);
      $("#adminSupplierCount").textContent = summaryResult.summary.suppliers;
      $("#adminAccountCount").textContent = summaryResult.summary.total_accounts;
      $("#adminOrderCount").textContent = summaryResult.summary.total_orders;
      $("#adminPaidPaymentCount").textContent = summaryResult.summary.paid_payments;
      renderAdminOverview(
        summaryResult.summary,
        productsResult.products,
        suppliersResult.suppliers,
        dealRequestsResult.requests
      );
      renderAdminBusinessMetrics(businessMetricsResult);
      filterAdminAccounts();
      filterAdminOrders();
      filterAdminPayments();
      filterAdminGroupDeals();
      renderAdminActivity(activityResult.activity);
    }
    return true;
  } catch (error) {
    errorMessage.textContent = `Unable to load your dashboard: ${error.message}`;
    errorMessage.hidden = false;
    return false;
  }
}

async function refreshDashboard() {
  const button = $("#dashboardRefresh");
  const errorMessage = $("#dashboardError");
  if (button.disabled) return;

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.classList.add("is-loading");
  errorMessage.hidden = true;

  try {
    const previousAccountState = [
      state.user?.role,
      state.user?.supplier_verified,
      state.user?.supplier_application_status
    ].join(":");
    const sessionResult = await apiRequest("/auth/me");
    state.user = sessionResult.user;
    updateAccountButton();
    const currentAccountState = [
      state.user.role,
      state.user.supplier_verified,
      state.user.supplier_application_status
    ].join(":");
    if (currentAccountState !== previousAccountState) showDashboard();

    const [productsLoaded, dealsLoaded, dashboardLoaded] = await Promise.all([
      loadProducts(),
      loadDeals(),
      loadDashboard()
    ]);

    if (!productsLoaded || !dealsLoaded || !dashboardLoaded) {
      const failures = [
        !productsLoaded && state.productsError,
        !dealsLoaded && "Unable to refresh group deals.",
        !dashboardLoaded && errorMessage.textContent
      ].filter(Boolean);
      errorMessage.textContent = failures.join(" ");
      errorMessage.hidden = false;
      return;
    }

    showToast("Dashboard refreshed with the latest data.");
  } catch (error) {
    errorMessage.textContent = `Unable to refresh your dashboard: ${error.message}`;
    errorMessage.hidden = false;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.classList.remove("is-loading");
  }
}

// Search and filters
$("#searchInput").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderProducts();
});

$("#sortSelect").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderProducts();
});

$("#quickOrderLines").addEventListener("change", (event) => {
  const select = event.target.closest("[data-quick-order-product]");
  if (select) updateQuickOrderLine(select.closest("[data-quick-order-line]"), true);
});

$("#quickOrderForm").addEventListener("click", (event) => {
  if (event.target.closest("[data-add-quick-order-line]")) {
    $("#quickOrderLines").insertAdjacentHTML("beforeend", quickOrderRowMarkup());
    return;
  }

  if (!event.target.closest("[data-remove-quick-order-line]")) return;
  const row = event.target.closest("[data-quick-order-line]");
  if ($("#quickOrderLines").querySelectorAll("[data-quick-order-line]").length > 1) {
    row.remove();
  } else {
    row.outerHTML = quickOrderRowMarkup();
    updateQuickOrderLine($("#quickOrderLines [data-quick-order-line]"));
  }
});

$("#quickOrderForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!userHasRole("buyer")) {
    showToast("Sign in with a buyer account to prepare an order.");
    return;
  }

  const quantities = new Map();
  for (const row of $("#quickOrderLines").querySelectorAll("[data-quick-order-line]")) {
    const productId = Number(row.querySelector("[data-quick-order-product]").value);
    const quantity = Number(row.querySelector("[data-quick-order-quantity]").value);
    if (!Number.isSafeInteger(productId) || !Number.isSafeInteger(quantity) || quantity < 1) {
      showToast("Choose a product and enter a whole-number quantity for each item.");
      return;
    }
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }

  if (!quantities.size) {
    showToast("Choose at least one wholesale product.");
    return;
  }

  for (const [productId, quantity] of quantities) {
    const product = products.find((item) => item.id === productId);
    const cartQuantity = state.cart[productId]?.quantity || 0;
    const orderQuantity = cartQuantity + quantity;
    if (!product || orderQuantity < product.minOrder || orderQuantity > product.stock) {
      showToast(
        product
          ? `${product.name} must be ordered in quantities from ${product.minOrder} to ${product.stock}.`
          : "One of the selected products is no longer available."
      );
      return;
    }
  }

  for (const [productId, quantity] of quantities) {
    const product = products.find((item) => item.id === productId);
    state.cart[productId] = {
      ...product,
      quantity: (state.cart[productId]?.quantity || 0) + quantity
    };
  }

  $("#quickOrderLines").innerHTML = quickOrderRowMarkup();
  updateQuickOrderLine($("#quickOrderLines [data-quick-order-line]"));
  renderCart();
  $("#cartButton").click();
});

$$("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.category = button.dataset.filter;
    state.showWishlistOnly = false;
    $("#savedProductsFilter").classList.remove("active");

    $$(".filter-button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });

    renderProducts();
    $("#products").scrollIntoView({ behavior: "smooth" });
  });
});

$("#savedProductsFilter").addEventListener("click", () => {
  if (!state.user) {
    openAuth();
    showToast("Sign in as a buyer to view your saved products.");
    return;
  }
  if (!userHasRole("buyer")) {
    showToast("Wishlists are available to buyer accounts.");
    return;
  }
  state.showWishlistOnly = !state.showWishlistOnly;
  state.category = "All";
  $$(".filter-button").forEach((item) => item.classList.remove("active"));
  if (state.showWishlistOnly) {
    $("#savedProductsFilter").classList.add("active");
  } else {
    $('[data-filter="All"]').classList.add("active");
  }
  renderProducts();
  $("#products").scrollIntoView({ behavior: "smooth" });
});

$$("[data-category]").forEach((button) => {
  button.addEventListener("click", () => {
    state.category = button.dataset.category;
    state.showWishlistOnly = false;
    $("#savedProductsFilter").classList.remove("active");

    $$(".filter-button").forEach((item) => {
      item.classList.toggle("active", item.dataset.filter === state.category);
    });

    renderProducts();
    $("#products").scrollIntoView({ behavior: "smooth" });
  });
});

// Product catalogue and cart
$("#productGrid").addEventListener("click", (event) => {
  const wishlistButton = event.target.closest("[data-toggle-wishlist]");
  if (wishlistButton) {
    void toggleWishlist(Number(wishlistButton.dataset.toggleWishlist), wishlistButton);
    return;
  }
  const reviewsButton = event.target.closest("[data-open-reviews]");
  if (reviewsButton) {
    void openProductReviews(Number(reviewsButton.dataset.openReviews));
    return;
  }
  const button = event.target.closest("[data-add-product]");
  if (button) addToCart(Number(button.dataset.addProduct));
});

$("#reviewDialogOverlay").addEventListener("click", (event) => {
  if (event.target.closest("[data-close-reviews]")) {
    $("#reviewDialogOverlay").hidden = true;
    state.reviewProduct = null;
    return;
  }
  if (event.target.closest("[data-review-sign-in]")) {
    $("#reviewDialogOverlay").hidden = true;
    openAuth();
  }
});

$("#reviewFormContainer").addEventListener("submit", async (event) => {
  const form = event.target.closest("#productReviewForm");
  if (!form || !state.reviewProduct) return;
  event.preventDefault();

  const submit = form.querySelector('button[type="submit"]');
  const error = $("#reviewFormError");
  submit.disabled = true;
  error.hidden = true;
  const values = new FormData(form);

  try {
    await apiRequest(`/reviews/${state.reviewProduct.id}`, {
      method: "POST",
      body: JSON.stringify({
        rating: Number(values.get("rating")),
        review_text: values.get("review_text")
      })
    });
    showToast("Thank you for sharing your verified review.");
    await loadProducts();
    await openProductReviews(state.reviewProduct.id);
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
    submit.disabled = false;
  }
});

$("#productGrid").addEventListener("error", (event) => {
  const image = event.target.closest("img[data-product-image]");
  if (!image) return;
  image.replaceWith(Object.assign(document.createElement("div"), {
    className: "product-image-placeholder",
    innerHTML: '<i class="fas fa-box-open" aria-hidden="true"></i>'
  }));
}, true);

$("#cartButton").addEventListener("click", () => {
  if (state.user?.role === "admin") return;
  renderCart();
  $("#cartOverlay").hidden = false;
});
$("#mobileCartButton").addEventListener("click", () => {
  if (state.user?.role === "admin") return;
  $("#cartButton").click();
});

async function monitorMpesaPayment(checkoutRequestId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 3000));
    let result;
    try {
      result = await apiRequest(
        `/payments/status/${encodeURIComponent(checkoutRequestId)}`
      );
    } catch (error) {
      showNotice(
        "Payment request sent",
        `The M-Pesa prompt was sent, but its status could not be checked: ${error.message}. Refresh your orders in a moment.`
      );
      return;
    }

    if (result.payment.status === "paid") {
      await loadDashboard();
      const receipt = result.payment.receipt_number
        ? ` Receipt: ${result.payment.receipt_number}.`
        : "";
      showNotice("Payment confirmed", `Order #${result.payment.order_id} was paid successfully.${receipt}`);
      return;
    }
    if (result.payment.status === "failed") {
      await loadDashboard();
      showNotice(
        "Payment not completed",
        `The payment for order #${result.payment.order_id} was not completed. You can try again from your order history.`
      );
      return;
    }
  }

  await loadDashboard();
  showNotice(
    "Payment is still processing",
    "We have not received final confirmation yet. Check your order history or refresh it shortly."
  );
}

async function requestMpesaPayment(orderId, phone) {
  const payment = await apiRequest("/payments/stk-push", {
    method: "POST",
    body: JSON.stringify({ order_id: orderId, phone })
  });
  showNotice("Check your phone", `Order #${orderId}. ${payment.message}`);
  await monitorMpesaPayment(payment.checkout_request_id);
}

$("#cartItems").addEventListener("change", (event) => {
  if (state.user?.role === "admin") return;
  const input = event.target.closest("[data-cart-quantity]");
  if (!input) return;

  const id = Number(input.dataset.cartQuantity);
  const quantity = Math.floor(Number(input.value));

  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100000) {
    showToast("Enter a quantity between 1 and 100,000.");
    renderCart();
    return;
  }

  state.cart[id].quantity = quantity;
  renderCart();
});

$("#cartItems").addEventListener("click", (event) => {
  if (state.user?.role === "admin") return;
  const button = event.target.closest("[data-remove-product]");
  if (!button) return;

  delete state.cart[Number(button.dataset.removeProduct)];
  renderCart();
  showToast("Product removed from your cart.");
});

$("#checkoutButton").addEventListener("click", async () => {
  if (state.user?.role === "admin") {
    $("#cartOverlay").hidden = true;
    showToast("Admin accounts cannot place buyer orders.");
    return;
  }
  if (!cartQuantity()) {
    showToast("Add wholesale products to your cart first.");
    return;
  }

  if (!state.user) {
    openAuth();
    showToast("Sign in before placing your order.");
    return;
  }
  if (!userHasRole("buyer")) {
    showToast("Only buyer accounts can place orders.");
    return;
  }

  const button = $("#checkoutButton");
  button.disabled = true;
  button.textContent = "Submitting order...";
  try {
    const payload = await apiRequest("/orders", {
      method: "POST",
      body: JSON.stringify({
        items: Object.values(state.cart).map((item) => ({
          product_id: item.id,
          quantity: item.quantity
        }))
      })
    });
    const orderId = payload.order.id;
    state.cart = {};
    renderCart();
    closeCart();
    await loadDashboard();
    showNotice(
      "Order placed",
      `Order #${orderId} is ready. Open your order history to see each supplier's payment details, pay them directly, and report each payment.`
    );
    await loadProducts();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Place order";
  }
});

$("#buyerOrders").addEventListener("submit", async (event) => {
  const paymentForm = event.target.closest(".supplier-payment-report");
  if (paymentForm) {
    event.preventDefault();
    const button = paymentForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const values = new FormData(paymentForm);
      const orderId = paymentForm.dataset.supplierPaymentOrder;
      const supplierId = paymentForm.dataset.supplierId;
      const result = await apiRequest(
        `/orders/${encodeURIComponent(orderId)}/supplier-payments/${encodeURIComponent(supplierId)}/report`,
        {
          method: "POST",
          body: JSON.stringify({ payment_method: values.get("payment_method") })
        }
      );
      showToast(result.message);
      await loadDashboard();
    } catch (error) {
      showToast(`Unable to report payment: ${error.message}`);
      button.disabled = false;
    }
    return;
  }

  const form = event.target.closest("[data-retry-payment]");
  if (!form) return;
  event.preventDefault();

  const phone = String(new FormData(form).get("phone") || "").trim();
  if (!/^(?:\+?254|0)?[71]\d{8}$/.test(phone.replace(/[\s-]/g, ""))) {
    showToast("Enter a valid Kenyan M-Pesa phone number.");
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await requestMpesaPayment(form.dataset.retryPayment, phone);
  } catch (error) {
    showNotice(
      "Payment could not start",
      `M-Pesa checkout could not start: ${error.message}. Please try again.`
    );
  } finally {
    button.disabled = false;
  }
});

const dealGrid = $("#dealGrid");
if (dealGrid) {
  dealGrid.addEventListener("input", (event) => {
    const input = event.target.closest("[data-calculator-deal]");
    if (!input) return;

    const dealId = Number(input.dataset.calculatorDeal);
    const deal = state.deals.find((item) => item.id === dealId);
    if (!deal) return;
    const remaining = Math.max(0, deal.target - deal.joined);
    const quantity = Number(input.value);

    if (!Number.isSafeInteger(quantity) || quantity < deal.minOrder || quantity > remaining) {
      return;
    }
    updateDealSavings(dealId, quantity);
  });

  dealGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-join-deal]");
    if (!button) return;

    const dealId = Number(button.dataset.joinDeal);
    const deal = state.deals.find((item) => item.id === dealId);
    if (!deal) return;

    if (!state.user) {
      openAuth();
      showToast("Sign in before joining a group deal.");
      return;
    }
    if (!userHasRole("buyer")) {
      showToast("Only buyer accounts can join group deals.");
      return;
    }

    const quantityInput = button.closest(".deal-card").querySelector(
      `[data-calculator-deal="${dealId}"]`
    );
    if (!quantityInput.reportValidity()) return;
    const quantity = Number(quantityInput.value);
    openDealCheckout(deal, quantity);
  });
}

$("#dealCheckoutOverlay").addEventListener("click", (event) => {
  if (!event.target.closest("[data-close-deal-checkout]")) return;
  $("#dealCheckoutOverlay").hidden = true;
  state.dealCheckout = null;
});

$("#dealCheckoutForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.dealCheckout) return;

  const errorMessage = $("#dealCheckoutError");
  const submit = $("#dealCheckoutSubmit");
  submit.disabled = true;
  submit.classList.add("is-loading");
  errorMessage.hidden = true;
  try {
    const checkout = state.dealCheckout;
    const result = await apiRequest(`/deals/${checkout.dealId}/join`, {
      method: "POST",
      body: JSON.stringify({ quantity: checkout.quantity })
    });
    $("#dealCheckoutOverlay").hidden = true;
    state.dealCheckout = null;
    await Promise.all([loadDeals(), loadProducts(), loadDashboard()]);
    showNotice(
      "Group order placed",
      `Order #${result.order.id} is ready. Open your order history for the supplier's payment details, then pay the supplier directly and report the payment.`
    );
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }
});

$("#authSwitchButton").addEventListener("click", () => {
  setAuthMode(state.authMode === "register" ? "login" : "register");
});

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const mode = state.authMode;
  const payload = {
    email: values.email,
    password: values.password
  };

  if (mode === "register") {
    payload.name = values.name;
    payload.phone = values.phone;
    payload.terms_accepted = values.terms_accepted === "true";
    payload.business_profile = {
      legal_business_name: values.legal_business_name,
      business_name: values.business_name,
      business_registration_number: values.business_registration_number,
      business_structure: values.business_structure,
      company_website: values.company_website,
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

  const submit = $("#authSubmit");
  const errorMessage = $("#authError");
  submit.disabled = true;
  errorMessage.hidden = true;
  try {
    const result = await apiRequest(`/auth/${mode === "register" ? "register" : "login"}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.user = result.user;
    state.dashboardMode = "buying";
    updateAccountButton();
    $("#authOverlay").hidden = true;
    $("#dashboard").hidden = true;
    form.reset();
    showToast(`Welcome${state.user.name ? `, ${state.user.name}` : ""}.`);
    if (state.user.terms_accepted_version !== CURRENT_TERMS_VERSION) {
      showTermsConsent();
    } else if (["admin", "sales"].includes(state.user.role)) {
      showDashboard();
    } else {
      void loadWishlist();
    }
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

$("#termsConsentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $("#termsConsentSubmit");
  const errorMessage = $("#termsConsentError");
  submit.disabled = true;
  errorMessage.hidden = true;

  try {
    const result = await apiRequest("/auth/accept-terms", {
      method: "POST",
      body: JSON.stringify({
        terms_accepted: new FormData(form).get("terms_accepted") === "true"
      })
    });
    state.user = result.user;
    $("#termsConsentOverlay").hidden = true;
    if (["admin", "sales"].includes(state.user.role)) {
      showDashboard();
    } else {
      await loadWishlist();
    }
    showToast("Terms accepted. You can continue using TradeCircle.");
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

$("#termsConsentSignOut").addEventListener("click", () => void signOut());

$("#dashboardLink").addEventListener("click", showDashboard);
$("#dashboardRefresh").addEventListener("click", () => void refreshDashboard());
$("#supplierButton").addEventListener("click", (event) => {
  if (!state.user) return;
  event.preventDefault();
  if (userHasRole("supplier")) {
    state.dashboardMode = "selling";
    showDashboard();
  } else if (state.user.role === "buyer") {
    showDashboard();
    if (state.user.supplier_application_status === "pending") {
      showToast("Your supplier application is awaiting admin review.");
    }
  } else {
    showToast("Admin accounts cannot become supplier accounts.");
  }
});

$("#footerSupplierLink").addEventListener("click", (event) => {
  if (!state.user) return;
  event.preventDefault();
  $("#supplierButton").click();
});

$("#togglePasswordVisibility").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const password = $("#authForm").elements.namedItem("password");
  const showPassword = password.type === "password";
  password.type = showPassword ? "text" : "password";
  button.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
  button.setAttribute("aria-pressed", String(showPassword));
  button.title = showPassword ? "Hide password" : "Show password";
  button.querySelector("i").className = `fas ${showPassword ? "fa-eye-slash" : "fa-eye"}`;
});
$("#forgotPasswordButton").addEventListener("click", () => {
  showNotice(
    "Password reset unavailable",
    "Password-reset email is not configured yet. Contact the TradeCircle administrator to reset your password."
  );
});
$("#adminQueueSearch").addEventListener("input", renderAdminOverviewQueue);
$("#adminQueueFilter").addEventListener("change", renderAdminOverviewQueue);
$("#adminAccountSearch").addEventListener("input", filterAdminAccounts);
$("#adminAccountKind").addEventListener("change", filterAdminAccounts);
$("#salesClientSearch").addEventListener("input", renderSalesClients);
$("#salesProductSearch").addEventListener("input", renderSalesProducts);
$("#salesProductCategory").addEventListener("change", renderSalesProducts);
$("#adminOrderSearch").addEventListener("input", filterAdminOrders);
$("#adminOrderStatus").addEventListener("change", filterAdminOrders);
$("#adminOrderPayment").addEventListener("change", filterAdminOrders);
$("#adminPaymentStatus").addEventListener("change", () => {
  state.adminData.paymentOrderId = null;
  filterAdminPayments();
});
$("#adminDealStatus").addEventListener("change", filterAdminGroupDeals);
$("#adminPreviewSupplier").addEventListener("change", () => void renderAdminPreview());
$("#buyerCartButton").addEventListener("click", () => $("#cartButton").click());
$("#dashboardNav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-dashboard-view]");
  if (button) setDashboardView(button.dataset.dashboardView);
  if (event.target.closest("[data-dashboard-sign-out]")) void signOut();
});
window.addEventListener("hashchange", () => {
  if (state.user?.role === "admin" && !$("#dashboard").hidden) {
    setDashboardView(adminViewFromHash(), false);
  }
});
$("#dashboardModeControls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-dashboard-mode]");
  if (!button || !userHasRole("supplier")) return;
  state.dashboardMode = button.dataset.dashboardMode;
  showDashboard();
});
$("#supplierApplicationForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void applySupplierAccess(event.currentTarget);
});
$("#supplierPaymentSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await apiRequest("/orders/supplier/payment-settings", {
      method: "PUT",
      body: JSON.stringify({
        payment_methods: values.getAll("payment_methods"),
        payment_instructions: values.get("payment_instructions")
      })
    });
    showToast("Payment settings saved.");
    form.elements.namedItem("payment_instructions").value =
      result.settings.payment_instructions;
    await loadDashboard();
  } catch (error) {
    showToast(`Unable to save payment settings: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});
$("#sellerDashboard").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-confirm-supplier-payment]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await apiRequest(
      `/orders/supplier-payments/${encodeURIComponent(button.dataset.confirmSupplierPayment)}/confirm`,
      { method: "POST" }
    );
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    showToast(`Unable to confirm payment: ${error.message}`);
    button.disabled = false;
  }
});
$("#deleteAccountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#deleteAccountButton");
  const error = $("#deleteAccountError");
  const values = new FormData(form);

  if (values.get("confirmation") !== "DELETE") {
    error.textContent = 'Type "DELETE" exactly to confirm account deletion.';
    error.hidden = false;
    return;
  }
  if (!window.confirm(
    "This permanently removes your personal profile and cannot be undone. Continue?"
  )) {
    return;
  }

  button.disabled = true;
  error.hidden = true;
  try {
    const result = await apiRequest("/auth/delete-account", {
      method: "POST",
      body: JSON.stringify({
        current_password: values.get("current_password"),
        confirmation: values.get("confirmation")
      })
    });
    state.user = null;
    state.dashboardMode = "buying";
    state.cart = {};
    state.wishlist.clear();
    state.showWishlistOnly = false;
    $("#savedProductsFilter").classList.remove("active");
    $("#dashboard").hidden = true;
    document.body.classList.remove("is-dashboard-view");
    document.body.classList.remove("is-admin-console");
    document.body.classList.remove("is-sales-console");
    $("#termsConsentOverlay").hidden = true;
    $("#authOverlay").hidden = true;
    updateAccountButton();
    renderProducts();
    form.reset();
    showToast(result.message);
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
$("#dashboard").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-dashboard-view]");
  if (button) {
    setDashboardView(button.dataset.openDashboardView);
    $("#adminDetailOverlay").hidden = true;
  }
});
$("#dashboard").addEventListener("click", (event) => {
  const salesClientButton = event.target.closest("[data-sales-client]");
  if (salesClientButton) {
    void openSalesClient(salesClientButton.dataset.salesClient);
    return;
  }
  const closeSalesClientButton = event.target.closest("[data-close-sales-client]");
  if (closeSalesClientButton) {
    $("#salesClientDetail").hidden = true;
    return;
  }
  const salesFollowupButton = event.target.closest("[data-sales-start-followup]");
  if (salesFollowupButton) {
    $("#salesFollowupBuyer").value = salesFollowupButton.dataset.salesStartFollowup;
    setDashboardView("follow-ups");
    $("#salesFollowupForm").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const salesRfqButton = event.target.closest("[data-sales-start-rfq]");
  if (salesRfqButton) {
    $("#salesRfqBuyer").value = salesRfqButton.dataset.salesStartRfq;
    setDashboardView("rfqs");
    $("#salesRfqForm").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const salesFollowupComplete = event.target.closest("[data-complete-sales-followup]");
  if (salesFollowupComplete) {
    salesFollowupComplete.disabled = true;
    void apiRequest(
      `/sales/followups/${encodeURIComponent(salesFollowupComplete.dataset.completeSalesFollowup)}`,
      { method: "PATCH", body: JSON.stringify({ status: "completed" }) }
    ).then(async () => {
      showToast("Follow-up marked completed.");
      await loadDashboard();
    }).catch((error) => {
      showToast(`Unable to update follow-up: ${error.message}`);
      salesFollowupComplete.disabled = false;
    });
    return;
  }
  const quoteStatusButton = event.target.closest("[data-sales-quote-status]");
  if (quoteStatusButton) {
    quoteStatusButton.disabled = true;
    void apiRequest(`/sales/quotes/${encodeURIComponent(quoteStatusButton.dataset.salesQuoteStatus)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: quoteStatusButton.dataset.nextQuoteStatus })
    }).then(async () => {
      showToast("Quote status updated. Sharing is recorded as a staff action; no message was sent.");
      await loadDashboard();
    }).catch((error) => {
      showToast(`Unable to update quote: ${error.message}`);
      quoteStatusButton.disabled = false;
    });
    return;
  }
  const rfqStatusButton = event.target.closest("[data-sales-rfq-status]");
  if (rfqStatusButton) {
    rfqStatusButton.disabled = true;
    void apiRequest(`/sales/rfqs/${encodeURIComponent(rfqStatusButton.dataset.salesRfqStatus)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: rfqStatusButton.dataset.nextRfqStatus })
    }).then(async () => {
      showToast("RFQ outcome updated.");
      await loadDashboard();
    }).catch((error) => {
      showToast(`Unable to update RFQ: ${error.message}`);
      rfqStatusButton.disabled = false;
    });
    return;
  }
  const salesAccessButton = event.target.closest("[data-sales-access-account]");
  if (salesAccessButton) {
    void updateAdminSalesAccess(salesAccessButton);
    return;
  }
  const accountButton = event.target.closest("[data-view-account]");
  if (accountButton) {
    void openAdminAccount(accountButton.dataset.viewAccount);
    return;
  }
  const productButton = event.target.closest("[data-view-product]");
  if (productButton) {
    void openAdminProduct(productButton.dataset.viewProduct);
    return;
  }
  const orderButton = event.target.closest("[data-open-order]");
  if (orderButton) {
    $("#adminDetailOverlay").hidden = true;
    state.adminData.orderSearch = String(orderButton.dataset.openOrder);
    $("#adminOrderSearch").value = state.adminData.orderSearch;
    $("#adminOrderStatus").value = "all";
    $("#adminOrderPayment").value = "all";
    setDashboardView("orders");
    filterAdminOrders();
    return;
  }
  const paymentButton = event.target.closest("[data-open-payment-order]");
  if (paymentButton) {
    state.adminData.paymentOrderId = String(paymentButton.dataset.openPaymentOrder);
    $("#adminPaymentStatus").value = "all";
    setDashboardView("payments");
    filterAdminPayments();
    return;
  }
  const previewButton = event.target.closest("[data-admin-preview-mode]");
  if (previewButton) {
    state.adminPreviewMode = previewButton.dataset.adminPreviewMode;
    void renderAdminPreview();
  }
  if (event.target.closest("[data-close-admin-detail]")) {
    $("#adminDetailOverlay").hidden = true;
  }
});

$("#salesFollowupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await apiRequest("/sales/followups", {
      method: "POST",
      body: JSON.stringify({
        buyer_id: Number(values.get("buyer_id")),
        title: values.get("title"),
        notes: values.get("notes"),
        due_at: values.get("due_at") || null
      })
    });
    form.reset();
    showToast("Follow-up saved.");
    await loadDashboard();
  } catch (error) {
    showToast(`Unable to save follow-up: ${error.message}`);
  } finally {
    submit.disabled = !state.salesData.clients.length;
  }
});

$("#salesRfqForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await apiRequest("/sales/rfqs", {
      method: "POST",
      body: JSON.stringify({
        buyer_id: Number(values.get("buyer_id")),
        quantity: Number(values.get("quantity")),
        target_price: values.get("target_price") || null,
        needed_by: values.get("needed_by") || null,
        requirements: values.get("requirements")
      })
    });
    form.reset();
    showToast("RFQ saved to the internal sales tracker.");
    await loadDashboard();
  } catch (error) {
    showToast(`Unable to save RFQ: ${error.message}`);
  } finally {
    submit.disabled = !state.salesData.clients.length;
  }
});

$("#salesRfqList").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-sales-quote-form]");
  if (!form) return;
  event.preventDefault();
  const values = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await apiRequest(`/sales/rfqs/${encodeURIComponent(form.dataset.salesQuoteForm)}/quotes`, {
      method: "POST",
      body: JSON.stringify({
        amount: Number(values.get("amount")),
        valid_until: values.get("valid_until") || null,
        terms: values.get("terms")
      })
    });
    showToast("Draft quote saved. It has not been sent to the buyer.");
    await loadDashboard();
  } catch (error) {
    showToast(`Unable to save quote: ${error.message}`);
    submit.disabled = false;
  }
});

$("#sellerProductForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  values.wholesale_price = Number(values.wholesale_price);
  values.minimum_quantity = Number(values.minimum_quantity);
  values.stock_quantity = Number(values.stock_quantity);
  values.image_url = values.image_url || null;

  try {
    const result = await apiRequest("/products", {
      method: "POST",
      body: JSON.stringify(values)
    });
    form.reset();
    form.elements.namedItem("minimum_quantity").value = "10";
    form.elements.namedItem("unit_label").value = "bag";
    form.elements.namedItem("stock_quantity").value = "0";
    showToast(result.message);
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
});

$("#sellerProducts").addEventListener("submit", async (event) => {
  const form = event.target.closest(
    "form[data-stock-product], form[data-edit-product], form[data-request-deal]"
  );
  if (!form) return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  const isStockUpdate = form.matches("[data-stock-product]");
  const isDealRequest = form.matches("[data-request-deal]");
  const dealEndsAt = isDealRequest ? new Date(values.ends_at) : null;
  if (dealEndsAt && Number.isNaN(dealEndsAt.getTime())) {
    showToast("Choose a valid group-deal end date.");
    return;
  }
  const url = isStockUpdate
    ? `/products/${form.dataset.stockProduct}/stock`
    : isDealRequest
      ? "/deals/requests"
      : `/products/${form.dataset.editProduct}`;
  const payload = isStockUpdate
    ? { stock_quantity: Number(values.stock_quantity) }
    : isDealRequest
      ? {
          product_id: Number(form.dataset.requestDeal),
          target_quantity: Number(values.target_quantity),
          discounted_price: Number(values.discounted_price),
          ends_at: dealEndsAt.toISOString(),
          supplier_note: values.supplier_note
        }
      : {
          ...values,
          wholesale_price: Number(values.wholesale_price),
          minimum_quantity: Number(values.minimum_quantity),
          image_url: values.image_url || null
        };

  try {
    const result = await apiRequest(url, {
      method: isDealRequest ? "POST" : "PATCH",
      body: JSON.stringify(payload)
    });
    showToast(result.message || (isDealRequest ? "Deal request sent." : "Product updated."));
    await Promise.all([loadDashboard(), loadProducts()]);
  } catch (error) {
    showToast(error.message);
  }
});

$("#sellerOrders").addEventListener("change", async (event) => {
  const select = event.target.closest("[data-order-item-status]");
  if (!select) return;
  select.disabled = true;
  try {
    await apiRequest(`/orders/supplier/items/${select.dataset.orderItemStatus}`, {
      method: "PATCH",
      body: JSON.stringify({ status: select.value })
    });
    showToast("Order fulfillment updated.");
    await loadDashboard();
  } catch (error) {
    showToast(error.message);
    await loadDashboard();
  }
});

$("#adminProducts").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-review-product]");
  if (!button) return;
  button.disabled = true;
  try {
    await apiRequest(`/admin/products/${button.dataset.reviewProduct}`, {
      method: "PATCH",
      body: JSON.stringify({ status: button.dataset.reviewStatus })
    });
    showToast(`Product ${button.dataset.reviewStatus}.`);
    await Promise.all([loadDashboard(), loadProducts(), loadDeals()]);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

$("#adminDealRequests").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-review-deal]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await apiRequest(`/admin/deal-requests/${button.dataset.reviewDeal}`, {
      method: "PATCH",
      body: JSON.stringify({ status: button.dataset.dealStatus })
    });
    showToast(result.status === "approved"
      ? "Supplier group deal approved and featured."
      : "Supplier group deal request rejected.");
    await Promise.all([loadDashboard(), loadDeals()]);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

$("#adminApprovedProducts").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-product]");
  if (!button) return;
  button.disabled = true;
  try {
    await apiRequest(`/admin/products/${button.dataset.removeProduct}`, {
      method: "DELETE"
    });
    showToast("Product listing removed from the marketplace.");
    await Promise.all([loadDashboard(), loadProducts(), loadDeals()]);
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

$("#adminSuppliers").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-supplier-decision]");
  if (!button) return;
  button.disabled = true;
  try {
    await apiRequest(
      `/admin/suppliers/${button.dataset.supplierDecision}/verification`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: button.dataset.applicationStatus
        })
      }
    );
    showToast(button.dataset.applicationStatus === "approved"
      ? "Supplier application approved. Selling Mode is now enabled."
      : "Supplier application rejected.");
    await Promise.all([loadDashboard(), loadProducts()]);
  } catch (error) {
    showToast(`Unable to update supplier application: ${error.message}`);
    button.disabled = false;
  }
});

// Close overlays
$$("[data-close-cart]").forEach((element) => {
  element.addEventListener("click", closeCart);
});

$$("[data-close-notice]").forEach((element) => {
  element.addEventListener("click", closeNotice);
});

$$("[data-close-auth]").forEach((element) => {
  element.addEventListener("click", () => {
    $("#authOverlay").hidden = true;
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeCart();
    closeNotice();
    $("#reviewDialogOverlay").hidden = true;
    state.reviewProduct = null;
    $("#dealCheckoutOverlay").hidden = true;
    state.dealCheckout = null;
    $("#authOverlay").hidden = true;
  }
});

// Responsive Bulma navigation
const burger = $(".navbar-burger");
const navigation = $("#mainNavigation");

burger.addEventListener("click", () => {
  const isActive = burger.classList.toggle("is-active");
  navigation.classList.toggle("is-active", isActive);
  burger.setAttribute("aria-expanded", String(isActive));
});

navigation.querySelectorAll("a.navbar-item").forEach((link) => {
  link.addEventListener("click", () => {
    burger.classList.remove("is-active");
    navigation.classList.remove("is-active");
    burger.setAttribute("aria-expanded", "false");
  });
});

$("#currentYear").textContent = new Date().getFullYear();

// Initial render
renderProducts();
renderDeals();
renderCart();
updateAccountButton();
void loadProducts();
void loadDeals();
void restoreSession();
window.setInterval(updateDealCountdowns, 1000);
