import { sealing } from "../../src/sealing";

/* Every login and key request in a test file seals to one pair made for the
   file, instead of one made for each request: a pair takes 80 ms of CPU, and
   32 of them were 2.6 s of the SDK's tests (24 October 2026). What is sealed
   and opened is still real RSA-OAEP. */
const made = sealing.pair();
sealing.pair = () => made;
