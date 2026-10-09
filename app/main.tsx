// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import React from "react";
import { createRoot } from "react-dom/client";
import Home from "./page";
import RecipientDocument from "./recipient";
import "./globals.css";
import { AppConfiguration } from "./config";
// Recipient links use the fragment so the token never reaches CloudFront/S3 logs and needs no SPA fallback.
const recipient = window.location.hash.match(/^#d=([A-Za-z0-9_-]{43})$/);
createRoot(document.getElementById("root")!).render(<React.StrictMode><AppConfiguration>{recipient?<RecipientDocument token={recipient[1]}/>:<Home />}</AppConfiguration></React.StrictMode>);
