"use client";

import { JsonData } from "../../components/json-data";
import { api } from "../../lib/api";

export default function AppHomePage() {
  return <JsonData title="Wallet" load={api.wallet} />;
}
