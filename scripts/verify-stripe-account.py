#!/usr/bin/env python3
"""Read-only Stripe account/product verifier that never prints credentials."""
from __future__ import annotations

import argparse
from pathlib import Path

import stripe


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--product", required=True)
    parser.add_argument("--price", required=True)
    args = parser.parse_args()

    env = read_env(args.env_file)
    secret = env.get("STRIPE_SECRET_KEY", "")
    if not secret:
        print("stripe_secret=EMPTY")
        return 2

    stripe.api_key = secret
    stripe.api_version = "2025-03-31.basil"
    account = stripe.Account.retrieve()
    product = stripe.Product.retrieve(args.product)
    price = stripe.Price.retrieve(args.price)

    profile = getattr(account, "business_profile", None)
    print(f"account_id={account.id}")
    print(f"business_name={getattr(profile, 'name', None) or ''}")
    print(f"product_id={product.id}")
    print(f"product_name={product.name}")
    print(f"product_active={bool(product.active)}")
    print(f"price_id={price.id}")
    print(f"price_product={price.product}")
    print(f"price_active={bool(price.active)}")
    print(f"price_amount={price.unit_amount}")
    print(f"price_currency={price.currency}")

    expected = (
        product.id == args.product
        and bool(product.active)
        and price.id == args.price
        and price.product == args.product
        and bool(price.active)
        and price.unit_amount == 1000
        and price.currency == "usd"
    )
    print(f"result={'PASS' if expected else 'MISMATCH'}")
    return 0 if expected else 1


if __name__ == "__main__":
    raise SystemExit(main())
