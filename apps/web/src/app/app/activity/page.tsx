"use client";

import { JsonData } from "../../../components/json-data";
import { api } from "../../../lib/api";

export default function ActivityPage() {
  return <JsonData title="Activity" load={api.activity} />;
}
