"use client";

import { JsonData, ActionButton } from "../../../components/json-data";
import { api } from "../../../lib/api";
import { subscribePush } from "../../../lib/kit";

export default function SettingsPage() {
  return (
    <main>
      <h1>Settings</h1>
      <JsonData title="Session" load={api.session} />
      <ActionButton label="Enable push notifications" action={subscribePush} />
    </main>
  );
}
