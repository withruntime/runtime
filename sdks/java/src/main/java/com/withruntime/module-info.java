/** The Java client for Runtime Cloud. No dependencies beyond the JDK. */
module com.withruntime {
  requires transitive java.net.http;

  exports com.withruntime;
}
