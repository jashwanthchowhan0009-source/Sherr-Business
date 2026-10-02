-- A free-text input type, beside the fixed chips.
--
-- The chips cover the documents an Indian trading business sees most, but there
-- is always a paper that is none of them, and "Something else" tells you nothing
-- three months later. A label the person typed themselves is the one thing that
-- will still make sense when they come back to it.
--
-- It is a label, not a classification: nothing in the engine reads it, exactly
-- as nothing reads declared_type. Both say what the person said it was.
alter table documents add column if not exists declared_label text;

alter table documents drop constraint if exists documents_declared_label_len;
alter table documents add constraint documents_declared_label_len
  check (declared_label is null or char_length(declared_label) between 1 and 60);
