-- Some HMIs publish a broken number that still has to be divided: a Haiwell B10S reports
-- 23855.671875 for 23,855 t/h, because the register is in kg/h. Until now the platform guessed
-- from the value itself -- a number with decimals was taken as already being in the right unit,
-- which is true of every other plant here (Campo Forte and Oliveira publish 19.44 and 30.24 with
-- a scale configured, and must keep being taken as they are). A guess cannot serve both, so the
-- intent is stated instead of inferred, and the default keeps today's behaviour exactly.
ALTER TABLE tags ADD COLUMN IF NOT EXISTS scale_always boolean NOT NULL DEFAULT false;
