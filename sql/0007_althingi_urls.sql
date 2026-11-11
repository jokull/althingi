-- 0007: the althingi.is page of each entity, as the source XML provides it (docs/DECISIONS.md "Deep links").
-- Nullable columns, no rewrite. Where NULL, src/althingi-urls.ts falls back to a pattern confirmed by URLs in the data.
alter table matters add column html_url text;   -- thingmalalisti <html>: …/ferill/?ltg=&mnr= (A) or …/bferill/ (B)
alter table members add column cv_url text;     -- thingmenn <html><lífshlaup>: /altext/cv/?nfaerslunr=<id>
alter table votes   add column html_url text;   -- atkvaedagreidslur <nánar><html>: /dba-bin/atkvgr.pl?nnafnak=<id>
