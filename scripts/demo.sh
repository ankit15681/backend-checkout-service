#!/usr/bin/env bash
# Executable walkthrough of the API against a running server.
#   COUPON_EVERY_N_ORDERS=2 npm start      # in one terminal
#   ./scripts/demo.sh                      # in another
# Requires curl and node (for JSON field extraction).
set -euo pipefail

B="${BASE_URL:-http://localhost:3000}"
J='content-type: application/json'
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Catalog"
curl -s "$B/products" | field products | head -c 400; echo " ..."

step "Create a cart and add items"
CART=$(curl -s -X POST "$B/carts" | field id)
curl -s -X POST "$B/carts/$CART/items" -H "$J" -d '{"productId":"keyboard","quantity":1}' >/dev/null
curl -s -X POST "$B/carts/$CART/items" -H "$J" -d '{"productId":"usb-c-cable","quantity":2}' | field subtotalCents

step "Invalid quantity is rejected (400 VALIDATION_ERROR)"
curl -s -X POST "$B/carts/$CART/items" -H "$J" -d '{"productId":"mouse","quantity":0}' | field error.code

step "Change quantity, view the cart"
curl -s -X PATCH "$B/carts/$CART/items/usb-c-cable" -H "$J" -d '{"quantity":3}' >/dev/null
curl -s "$B/carts/$CART"; echo

step "Checkout (201), then retry the same request (200, same order)"
curl -s -o /dev/null -w 'status %{http_code}\n' -X POST "$B/carts/$CART/checkout"
ORDER=$(curl -s -X POST "$B/carts/$CART/checkout" | field id)
curl -s -o /dev/null -w 'retry status %{http_code}\n' -X POST "$B/carts/$CART/checkout"
echo "order $ORDER"

step "Place another order to reach the milestone, then generate a coupon (admin)"
C2=$(curl -s -X POST "$B/carts" | field id)
curl -s -X POST "$B/carts/$C2/items" -H "$J" -d '{"productId":"mouse","quantity":1}' >/dev/null
curl -s -X POST "$B/carts/$C2/checkout" >/dev/null
COUPON=$(curl -s -X POST "$B/admin/coupons" | tee /dev/stderr | field code); echo

step "Use the coupon"
C3=$(curl -s -X POST "$B/carts" | field id)
curl -s -X POST "$B/carts/$C3/items" -H "$J" -d '{"productId":"monitor","quantity":1}' >/dev/null
curl -s -X POST "$B/carts/$C3/checkout" -H "$J" -d "{\"couponCode\":\"$COUPON\"}" | field discount

step "Reuse the coupon (409 COUPON_ALREADY_REDEEMED)"
C4=$(curl -s -X POST "$B/carts" | field id)
curl -s -X POST "$B/carts/$C4/items" -H "$J" -d '{"productId":"mouse","quantity":1}' >/dev/null
curl -s -X POST "$B/carts/$C4/checkout" -H "$J" -d "{\"couponCode\":\"$COUPON\"}" | field error.code

step "Admin report"
curl -s "$B/admin/report"; echo
