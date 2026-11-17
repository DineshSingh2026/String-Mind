'use client';
import { AdminHeader, AutoEndpoint } from '@/components/admin/kit';

export default function AdminSecurityPage() {
  return (
    <div>
      <AdminHeader title="Security" description="Failed logins, suspicious events and training messages flagged by the safety filter (prompt injection, benchmark leakage, unsafe content)." />
      <AutoEndpoint path="/admin/security" />
    </div>
  );
}
