'use client';
import { AdminHeader, AutoEndpoint } from '@/components/admin/kit';

export default function AdminHealthPage() {
  return (
    <div>
      <AdminHeader title="System health" description="Database, job queue lag and provider health counts (GET /admin/system-health). Auto-refreshes every 30s." />
      <AutoEndpoint path="/admin/system-health" />
    </div>
  );
}
