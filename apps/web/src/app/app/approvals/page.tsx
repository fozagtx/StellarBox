"use client";

import { JsonData } from "../../../components/json-data";
import { api } from "../../../lib/api";

export default function ApprovalsPage() {
  return <JsonData title="Approvals" load={api.approvals} />;
}
