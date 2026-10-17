"use client";

import { JsonData } from "../../../components/json-data";
import { api } from "../../../lib/api";

export default function GrantsPage() {
  return (
    <main>
      <h1>Grants</h1>
      <a href="/app/grants/new">Create a grant</a>
      <JsonData title="Grant data" load={api.grants} />
    </main>
  );
}
