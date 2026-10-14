# Surgical QA26 mobile login CSS canary: preserves every JS asset and runtime route.
# Exact QA26 tenant-pinned image; NEVER switch to generic :prod.
FROM ghcr.io/dansut24/hi5central-platform-itsm:sha-f51d2e634e450e03214f10d845f90f73f7b2d506
COPY scripts/mobile-auth-viewport.canonical.css /tmp/mobile-auth-viewport.css
RUN set -eu; \
    old=/srv/assets/index-DsBct1dA.css; \
    test -s "$old"; \
    printf '%s  %s\n' dff58e52c9f836f5fc3decf31669ce0ed772cd7738aad7368888ef1cab6820f6 "$old" | sha256sum -c -; \
    printf '%s  %s\n' e37c7d4f33fb240131da3ded3b71916ac28b095d57d9407f75da9810a654c3df /srv/assets/index-D6rmr1K4.js | sha256sum -c -; \
    printf '%s  %s\n' 47b206665bc592b5e4672365686ec9c6961a26f17413f4ba08260d020a82383e /srv/index.html | sha256sum -c -; \
    grep -q index-DsBct1dA.css /srv/index.html; \
    test -s /tmp/mobile-auth-viewport.css; \
    patch_hash="$(sha256sum /tmp/mobile-auth-viewport.css | cut -c1-12)"; \
    replacement="index-authscroll-${patch_hash}.css"; \
    cp "$old" "/srv/assets/$replacement"; \
    printf '\n/* Hi5Central canonical mobile login scroll fix */\n' >> "/srv/assets/$replacement"; \
    cat /tmp/mobile-auth-viewport.css >> "/srv/assets/$replacement"; \
    sed -i "s/index-DsBct1dA.css/$replacement/g" /srv/index.html; \
    grep -q "$replacement" /srv/index.html; \
    ! grep -q 'index-DsBct1dA.css' /srv/index.html; \
    printf '%s\n' "$replacement" >/srv/qa26-mobile-style.txt; \
    printf 'QA26 overlay built using original JS and original CSS with appended canonical mobile-scroll override\n'
LABEL hi5central.scope="qa26-css-only-login-viewport"
