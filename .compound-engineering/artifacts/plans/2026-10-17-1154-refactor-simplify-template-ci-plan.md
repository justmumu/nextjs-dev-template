---
title: "Simplify Template CI - Plan"
type: refactor
date: 2026-10-17
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Simplify Template CI - Plan

## Goal Capsule

Template CI'dan `infrastructure-macos` ve `no-python` işlerini, `push: main` tetikleyicisini ve bunlara bağlı Docker/seccomp test düzeneğini kaldırmak. Kalan yapı `plan -> generator-integration -> template-ci-result` olacak. İş mevcut PR1'e (`codex/nextjs-template-plan`) eklenir. Yeni PR, yeni kapı ya da yeni test düzeneği açılmaz.

## Product Contract

### Summary

Kullanıcı macOS altyapı işini, Python'suz kabul ortamını ve Template CI'ın `main` push'unda ikinci kez koşmasını gereksiz buldu. Bu üç karar oturumda kesinleşti, yeniden tartışılmaz. Plan yalnızca bunları ve doğrudan yetim kalan referansları temizler.

### Problem Frame

- `.github/workflows/template-ci.yml` hem `pull_request` hem `push: main` ile koşuyor. Python kaynaktaki Template CI yalnızca `pull_request` ile koşar, çünkü merge ağacı PR'da zaten test edilmiştir. Push koşusu aynı ağacı ikinci kez test ediyor.
- `infrastructure-macos` (macos-15) ve `no-python` (Docker + Moby seccomp profili) bakımı ağır işler. Kullanıcı bu güvenceleri istemiyor.
- `docs/contributing/ci.md` ve `docs/guides/platforms.md` bu işlere dayanan kapsam iddiaları taşıyor. Ayrıca kullanıcının daha önce geri çektiği WSL2 smoke makbuzu şartı da hâlâ bu belgelerde duruyor.
- `2026-10-16-1751-feat-nextjs-development-template-plan.md` değiştirilmez. Bu plan o belgedeki yalnızca CI macOS hattı, no-Python kabulü ve platform/WSL kabulü maddelerinin yerine geçer. Planın geri kalanı geçerli kalır.

### Requirements

- R1. Template CI tetikleyicileri tam olarak `pull_request` ve `workflow_dispatch` olur. `push`, `schedule` ya da başka bir yedek tetikleyici eklenmez. `concurrency` bloğu aynen kalır.
- R2. `infrastructure-macos` ve `no-python` işleri silinir. Sonuç işinin bağımlılıkları `needs: [plan, generator-integration]` olur, `if: always()` ve hata/iptal koşulu aynen kalır. Var olmayan bir işe `needs` referansı kalmaz.
- R3. Şu dosyalar silinir: `.github/no-python/Dockerfile`, `scripts/ci/no-python.cjs`, `tests/unit/no-python.test.ts`, `tests/integration/no-python.test.ts`.
- R4. Şunlar korunur:
  - `.github/workflows/ci.yml` içindeki `push: main` tetikleyicisi
  - Linux `generator-integration` işi ve onun `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` adımı
  - browser, standalone ve offline-build kanıtları
  - macOS işinin seçtiği, Linux'ta zaten koşan sıradan entegrasyon testleri
  - paylaşılan namespace/toolchain yardımcıları (`scripts/core/*`)
  - `tooling/template-manifest.json` içindeki paylaşılan workflow eşlemesi (yaklaşık satır 1141)
- R5. Silinen dosyalara işaret eden referanslar temizlenir. Bu referanslar `tests/contracts/workflows.test.ts`, `tests/contracts/source-trace.json`, `tests/integration/unit-suites.test.ts`, `tests/integration/acceptance.test.ts` ve `tests/integration/coverage-gates.test.ts` içinde. Yeni bir test düzeneği eklenmez. Gerekirse mevcut küçük entegrasyon dosyalarına yönlendirilir.
- R6. Workflow dosyası template manifest üzerinden byte-byte ve mod dahil kopyalanır, ayrı bir `template/app/.github/workflows` dosyası yoktur. Üretilen uygulamadaki workflow'un kaynakla aynı kalması mevcut render testiyle doğrulanır.
- R7. Kök belgeler ve uygulamaya yayılan belgeler yalnızca bu kaldırmayı ve WSL2 makbuz şartının geri çekilmesini yansıtacak kadar güncellenir. Gerçek araç zincirinin yalnızca JS olduğu iddiası (Python, uv, Make gerekmez) kalır. Ancak hiçbir belge, işletim sisteminde Python bulunmadığının kanıtlandığını iddia etmez.
- R8. Staged durumdaki sekiz CI fixture düzeltmesi sıfırlanmaz. `tests/integration/no-python.test.ts` üzerindeki staged değişiklik dosya silinince kendiliğinden geçersiz olur. Diğer yedi değişiklik korunur: `coverage-gates`, `docs-dependencies`, `guard-routes`, `public-cancellation`, `template-update-relock`, `tests/support/installed-tools.ts`, `tests/support/rendered-app.ts`. `installed-tools.ts`, `docs-dependencies` ve `template-update-relock` tarafından hâlâ kullanılır.
- R9. Kapsam dışı: zamanlanmış yedek tetikleyici, docs-path filtresi, cache optimizasyonu, bağımlılık veya release değişikliği, yeni kapı.

## Planning Contract

- KTD1. Template CI yalnızca PR'da ve elle başlatılınca koşar. `session-settled: user-directed`; reddedilen alternatif: Template CI main push tekrarı. Gerekçe: merge ağacı PR'da test edilmiştir, Python kaynak da böyle çalışır. Ortak CI `main` push'unda koşmaya devam eder.
- KTD2. Hedef iş grafiği: `plan` -> `generator-integration` (`needs: plan`, `if: role == 'generator'`) -> `template-ci-result` (`needs: [plan, generator-integration]`, `if: always()`). Dosya başındaki "path filtresi yok, sonuç işi her zaman raporlar" yorumu kalır. PR-only gerekçesi tek satırla eklenir.
- KTD3. Kaldırma sınırları kesindir. `session-settled: user-directed`; macOS ve Python bulunmayan ortam kontrolleri kaldırılır, yerine yeni kontrol eklenmez. Paylaşılan yardımcılar (`resolveOnPath`, `runInherited`, `args`, `json`) ve sysctl adımı üretim testlerinde kullanıldığı için silinmez. Değiştirilen her test dosyasında yalnızca no-python/macOS'a özgü parçalar çıkarılır.
- KTD4. Yetim test hedefleri mevcut dosyalara yönlendirilir:
  - `tests/integration/unit-suites.test.ts` "an integration file is run through its own suite" testi: küçük ve hızlı mevcut bir entegrasyon dosyası (öneri: `tests/integration/ci-context.test.ts`).
  - `tests/integration/coverage-gates.test.ts:87`: üretilen uygulamada bulunmayan, yalnızca generator'da olan bir entegrasyon dosyası (öneri: `tests/integration/template-create.test.ts`). "Generator'a özgü test reddedilir" kontrolü korunur.
- KTD5. `tests/contracts/source-trace.json` içindeki `test_commit_message_hook_works_without_global_python` kaydında (yaklaşık satır 967-985) `hooks.test.ts` kanıtı kalır. `no-python.test.ts` girdisi ve not metnindeki "Node-and-pnpm-only environment is proven separately" ifadesi çıkarılır. Status `adapted` olarak kalır.
- KTD6. Planlama sırasında test koşulmaz ve staged değişikliklerin önceki sonuçları nihai kanıt sayılmaz.
- KTD7. Uygulama ayrı bir onayla yapılır. Korumalı dosya düzenlemeleri AGENTS kurallarına göre onaylı yoldan geçer. PR1'e push için ayrıca açık onay gerekir. İlgili değişiklikler birlikte yayımlanır; ek push gerekirse yeniden onay alınır.

## Implementation Units

### U1. Workflow and harness removal

Dosyalar: `.github/workflows/template-ci.yml`, `.github/no-python/Dockerfile`, `scripts/ci/no-python.cjs`, `tests/unit/no-python.test.ts`, `tests/integration/no-python.test.ts`

- `on:` bloğundan `push: branches: [main]` çıkarılır. `pull_request` ve `workflow_dispatch` kalır.
- `infrastructure-macos` ve `no-python` işleri silinir. `template-ci-result.needs` değeri `[plan, generator-integration]` olur.
- KTD2'deki yorum satırı eklenir. `generator-integration` adımlarına dokunulmaz.
- Dört harness dosyası silinir. Integration dosyasındaki staged değişiklik bilinçli olarak düşer, diğer staged dosyalar korunur (R8).

### U2. Contract and integration test cleanup

Dosyalar: `tests/contracts/workflows.test.ts`, `tests/contracts/source-trace.json`, `tests/integration/unit-suites.test.ts`, `tests/integration/acceptance.test.ts`, `tests/integration/coverage-gates.test.ts`

`workflows.test.ts`:
- `describe("the no-Python image")` bloğu silinir.
- Rendered dosyalar testindeki `.github/no-python` ve `scripts/ci/no-python.cjs` kontrolleri çıkarılır.
- Role testindeki iş listesi `["generator-integration"]` olur.
- Lane testinden macOS satırı çıkar ve başlıktaki "macOS runs no browsers" ifadesi silinir.
- Runner testi: her iş `ubuntu-24.04`. Başlıktaki macOS istisnası kalkar.
- Generator integration testinden macOS scenario döngüsü çıkar.
- Bir kontrol eklenir: Template CI tetikleyicileri tam olarak `pull_request` ve `workflow_dispatch`; `push` ve `schedule` yok. `ci.yml` hâlâ `push: branches: [main]` içeriyor.
- Mevcut "result job needs every other job" testi `[plan, generator-integration]` sonucunu kendiliğinden doğrular.

`acceptance.test.ts`:
- Satır 18'deki `noPython` require'ı silinir.
- Satır 147-162'deki harness scenario testi ve satır 171-173'teki FORBIDDEN testi silinir.
- Satır 168'deki `template-ci ... no-python` kontrolü çıkarılır.
- İlk adoption/guard/hook testi ile production/standalone/release kontrolleri kalır. Boş kalmazsa `describe` adı korunur.

Diğerleri:
- `unit-suites.test.ts` ve `coverage-gates.test.ts` KTD4'e göre yönlendirilir.
- `source-trace.json` KTD5'e göre düzeltilir.

### U3. Documentation alignment

Dosyalar: `docs/contributing/ci.md`, `docs/guides/platforms.md`. Uygulamaya yayılan belgeler yalnızca kontrol edilir.

`docs/contributing/ci.md`:
- Girişteki "behavior on machines without Python" ifadesi çıkar.
- Workflow tablosunda `template-ci.yml` satırı "pull request, manual / Generator integration" olur.
- Lanes tablosundan macOS ve No-Python satırları silinir.
- "Supported platforms" bölümünde CI kapsamı Linux x64 olur. macOS CI kapsamı ve WSL2 smoke makbuzu şartı çıkarılır.
- "The no-Python image" bölümü silinir. Sondaki browser-integration paragrafı "Lanes and cost" altına taşınır.

`docs/guides/platforms.md`:
- Linux x64 ve ARM64 satırlarından no-Python image referansları çıkar.
- macOS satırı "CI kapsamı yok" olur.
- WSL2 satırından makbuz şartı çıkar, Linux filesystem sözleşmesi kalır.
- "No Python, uv ... needed" cümlesi kalır.

Uygulamaya yayılan belgeler:
- `template/app/docs/contributing/ci.md:83`, `docs/updating.md`, `template/app/docs/updating.md` ve `docs/contributing/agents.md` silinen işlere ya da WSL makbuzuna referans vermiyor, değişmez.
- Render çıktısı manifestle eşleşmeye devam eder.

## Verification Contract

- V1. Statik kanıt: `.github/workflows/template-ci.yml` içinde `push:`, `schedule:`, `macos`, `no-python` ifadeleri yok. `needs` alanında yalnızca var olan işler geçiyor. Grafik KTD2 ile birebir aynı.
- V2. Repo genelinde arama (`.compound-engineering/**` hariç): `no-python`, `noPython`, `No-Python`, `infrastructure-macos`, `macos-15` için eşleşme yok. `WSL2 smoke receipt` ifadesi hiçbir belgede kalmamış.
- V3. Odaklı testler:
  - `pnpm run test:one --test=tests/contracts/workflows.test.ts`
  - `pnpm run test:one --test=tests/contracts/source-trace.test.ts`
  - `pnpm run test:one --test=tests/integration/unit-suites.test.ts --suite=integration`
  - `pnpm run test:one --test=tests/integration/coverage-gates.test.ts --suite=integration`
  - `pnpm run test:one --test=tests/integration/acceptance.test.ts --suite=integration`
- V4. Workflow parity: `workflows.test.ts` içindeki render testi, üretilen uygulamadaki `.github/workflows/*.yml` dosyalarının kaynakla byte ve mod olarak aynı olduğunu doğrular. Source-trace testi silinmiş dosyaya referans kalmadığını doğrular.
- V5. Commit ve pre-push hook'ları geçer. Ardından onaylı tek bir push ile PR1 üzerinde hosted CI koşar ve **CI result** ile **Template CI result** yeşil olur. Template CI'ın PR olayıyla tetiklendiği ve `main` push'unda koşmadığı tetikleyici tanımından doğrulanır.
- V6. Kapsam iddiası: kod yalnızca JS kullanmaya devam eder. Bu, işletim sisteminde Python bulunmadığının kanıtı olarak sunulmaz.

## Definition of Done

- R1-R9 karşılanmış. U1-U3 PR1 dalında tek commit (ya da mantıksal birkaç commit) olarak duruyor ve yeni PR açılmamış.
- V1-V6 sonuçları gerçek çıktılarla raporlanmış. Başarısız bir adım varsa olduğu gibi bildirilmiş.
- Yedi ilgisiz staged fixture düzeltmesi korunmuş. Yalnızca silinen dosyanın staged değişikliği düşmüş.
- Orijinal plan dosyası değişmemiş. Bu plan yalnızca CI, no-Python ve platform kabulü maddelerinin yerine geçiyor.
- Her push yalnızca açık onay alındıktan sonra yapılmış.
