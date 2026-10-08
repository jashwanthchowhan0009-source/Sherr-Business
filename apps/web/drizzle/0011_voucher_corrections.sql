-- Editing an entry.
--
-- A posted voucher still cannot be changed in place: that is invariant 2 in
-- 0003 and it stays. "Edit" on a posted voucher is a correction — the original
-- is reversed and a replacement is posted in the same transaction — so the
-- books keep the mistake, the reversal and the fix, which is what the Companies
-- Act audit trail expects. This migration adds what that needs.

-- 1. The replacement names the voucher it corrects, so the trail runs both
--    ways: original → reversed_by → reversal, and replacement → corrects →
--    original. Composite with org_id, like every other voucher reference, so a
--    reference can never cross tenants.
alter table vouchers add column if not exists corrects_voucher_id uuid;

alter table vouchers drop constraint if exists vouchers_corrects_org_fkey;
alter table vouchers add constraint vouchers_corrects_org_fkey
  foreign key (corrects_voucher_id, org_id) references vouchers (id, org_id) on delete restrict;

create index if not exists vouchers_corrects_idx
  on vouchers (corrects_voucher_id) where corrects_voucher_id is not null;

-- 2. The duplicate-bill guard ignores a bill once it has been reversed.
--
--    Correcting a bill re-enters the same supplier invoice number, and the
--    original stays posted (reversed, not deleted). Without this the unique
--    index would refuse the corrected bill as a duplicate of the one it
--    replaces. A reversed bill can no longer be paid, so it can no longer be
--    paid twice, which is the only thing the index exists to prevent.
--
--    reversed_by_voucher_id is the one column a posted voucher may have written
--    to it, and it is written before the replacement is inserted, so within the
--    correction transaction the original has already left the index.
drop index if exists vouchers_supplier_ref_key;
create unique index if not exists vouchers_supplier_ref_key
  on vouchers (org_id, party_id, upper(supplier_invoice_no), fy_label)
  where supplier_invoice_no is not null
    and voucher_type in ('purchase', 'debit_note')
    and status = 'posted'
    and reversed_by_voucher_id is null;
